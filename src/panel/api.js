/**
 * Host HTTP surface for the Settings panel.
 *
 * Routes live under a top-level `/workbuddy` namespace (the same convention
 * `dsh-host-open-in-app` uses with `/open-in-app`), deliberately outside
 * `/api`, which the client-connection bridge owns as a prefix route.
 *
 * Every route passes the connection trust fence first, so only peers the
 * running Web GUI already admits can read account state or start a login.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { accountIdOf, beginLogin, logoutRegion, pendingLogins, readMeta, readToken, refreshRegion, regionStatus } from '../account/auth.js'
import { invalidateBusy, fetchBusyLevels } from '../catalog/busy.js'
import { SWEEP_MIN_INTERVAL_MS, availabilitySummary, readAvailability, runSweep, sweepDue, unusableModelIds } from '../catalog/availability.js'
import { claimDailyCheckin, fetchCheckinStatus, fetchCredits } from '../account/credits.js'
import { localDayKey } from '../core/http.js'
import { isEnabled, readPrefs, setEnabled } from '../catalog/model-prefs.js'
import { readOfficialList, writeOfficialList } from '../catalog/official-list.js'
import { REGIONS, REGION_IDS, sitePageUrl } from '../core/regions.js'
import { notifyModelTopology } from '../core/topology.js'
import { setCredential } from '../core/paths.js'

const API_PREFIX = '/workbuddy'
const MAX_BODY_BYTES = 16 * 1024
/**
 * The same artwork the plugin inventory shows, served to the panel's header.
 *
 * Two levels up: this file lives in `src/panel/`, the artwork at the package root. The
 * relative path was `../icon.webp` before the role folders existed, and a stale one here
 * fails at request time, not at import time — which is exactly how it reached a release.
 */
const ICON_PATH = fileURLToPath(new URL('../../icon.webp', import.meta.url))
/** The same mark as an alpha-only silhouette, which the panel uses as a CSS mask. */
const MASK_PATH = fileURLToPath(new URL('../../icon-mask.png', import.meta.url))
let iconBytes
let maskBytes

/** Late-bound so importing this module never pulls in the child-process helper. */
async function defaultOpenInBrowser(url) {
  const { openInBrowser } = await import('./regions.js')
  return openInBrowser(url)
}

/**
 * Which build of this file the running host actually loaded.
 *
 * A reload does not replace the routes an earlier load registered — the host
 * keeps serving the first registration it was given — so a panel talking to a
 * stale instance fails with `not found` on newer routes (that is how `/credits`
 * went missing once). Printing the file's timestamp on mount makes the running
 * build identifiable in the host log.
 */
const CODE_STAMP = (() => {
  try {
    const self = fileURLToPath(import.meta.url)
    // A content hash identifies the build without depending on the host's time
    // zone (the host process here runs in UTC while its log prints local time,
    // which made a clock-based stamp read as the wrong hour).
    const hash = createHash('sha256').update(readFileSync(self)).digest('hex').slice(0, 8)
    return `api.js #${hash} (${statSync(self).mtime.toISOString().slice(0, 16)}Z)`
  } catch {
    return 'api.js (unidentified)'
  }
})()

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded JSON body; returns undefined when it is oversized or not a JSON object. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

async function statePayload(ctx, adapters) {
  const regions = []
  for (const id of REGION_IDS) {
    const region = REGIONS[id]
    const status = await regionStatus(ctx, region)
    const meta = await readMeta(ctx, region)
    const token = await readToken(ctx, region)
    const signedIn = token.length > 0
    let models = 0
    let modelsSource = null
    let modelsCachedAt = null
    if (signedIn && adapters[id] !== undefined) {
      try {
        models = (await adapters[id].models()).length
        modelsSource = adapters[id].catalogSource ?? null
        modelsCachedAt = adapters[id].catalogCachedAt ?? null
      } catch {
        models = 0
      }
    }
    let credits
    let checkin
    if (signedIn) {
      const [creditResult, checkinResult] = await Promise.all([
        fetchCredits(ctx, region).catch((error) => ({ supported: true, ok: false, reason: String(error?.message ?? error) })),
        fetchCheckinStatus(ctx, region).catch((error) => ({ supported: true, ok: false, reason: String(error?.message ?? error) }))
      ])
      credits = creditResult
      checkin = checkinResult
    }
    regions.push({
      id,
      label: region.label,
      provider: region.provider,
      endpoint: region.endpoint,
      loggedIn: status.loggedIn,
      pending: pendingLogins.has(id),
      nickname: typeof meta?.nickname === 'string' ? meta.nickname : '',
      expiresAt: typeof meta?.expiresAt === 'number' ? meta.expiresAt : 0,
      refreshable: typeof meta?.refreshToken === 'string' && meta.refreshToken.length > 0,
      models,
      modelsSource,
      modelsCachedAt,
      hasBusy: region.hasBusy === true,
      credits: credits ?? null,
      checkin: checkin ?? null,
      lastClaim: typeof meta?.checkin === 'object' && meta.checkin !== null ? meta.checkin : null
    })
  }
  return { regions }
}

/**
 * Register the panel's routes. Call inside `ctx.inject(['webServer'], …)` so a
 * composition without an HTTP carrier keeps the adapter and the command.
 *
 * @param {object} ctx - host plugin context.
 * @param {Record<string, object>} adapters - per-deployment adapters.
 * @param {{ openInBrowser?: (url: string) => boolean }} [options] - the browser
 *   opener is injectable so tests never launch a real one.
 */
export function registerWorkbuddyApi(ctx, adapters, options = {}) {
  const openInBrowser = options.openInBrowser ?? defaultOpenInBrowser
  const rejected = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /**
   * One-time token for the console capture.
   *
   * The account list can only be read from inside a signed-in console page, so
   * the panel hands the user a snippet to paste there; that snippet posts the
   * ids back here from the workbuddy origin, which the trust fence would reject.
   * A per-run random token is the narrow bypass: it is only handed out through
   * `/state` (which is fenced), it is worthless for anything but importing a
   * model list, and a page that does not have it cannot reach the route at all.
   */
  const captureToken = crypto.randomUUID().replace(/-/g, '')
  const isCapturePost = (req, url, method) => method === 'POST' &&
    url.pathname === `${API_PREFIX}/import` &&
    url.searchParams.get('token') === captureToken

  const handler = async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const method = req.method ?? 'GET'
    if (!isCapturePost(req, url, method) && rejected(req, res)) return
    const path = url.pathname

    try {
      if (path === `${API_PREFIX}/state` && method === 'GET') {
        const payload = await statePayload(ctx, adapters)
        sendJson(res, 200, { ...payload, importToken: captureToken })
        return
      }

      // The browser has no devtools in the packaged desktop app, so the panel
      // reports its load stages here; they land in the host log.
      if (path === `${API_PREFIX}/client-log` && method === 'POST') {
        const body = await readJsonBody(req)
        ctx.logger.info(`[workbuddy] client half: ${JSON.stringify(body ?? {})}`)
        sendJson(res, 200, { ok: true })
        return
      }

      /**
       * The logo, twice: the opaque mark for surfaces that want a fixed colour,
       * and the alpha-only silhouette the panel paints with a theme colour
       * through a CSS mask.
       */
      if ((path === `${API_PREFIX}/icon` || path === `${API_PREFIX}/icon-mask`) && method === 'GET') {
        const isMask = path.endsWith('icon-mask')
        try {
          if (isMask) maskBytes ??= await readFile(MASK_PATH)
          else iconBytes ??= await readFile(ICON_PATH)
          res.statusCode = 200
          res.setHeader('content-type', isMask ? 'image/png' : 'image/webp')
          res.setHeader('cache-control', 'public, max-age=3600')
          res.end(isMask ? maskBytes : iconBytes)
        } catch {
          res.statusCode = 404
          res.end()
        }
        return
      }

      if (path === `${API_PREFIX}/models` && method === 'GET') {
        const region = REGIONS[url.searchParams.get('region') ?? '']
        if (region === undefined) {
          sendJson(res, 400, { error: 'unknown region' })
          return
        }
        const adapter = adapters[region.id]
        if (adapter === undefined) {
          sendJson(res, 400, { error: 'provider route is not mounted' })
          return
        }
        try {
          // The adapter's catalog is the merged one the model picker sees:
          // both live endpoints merged when they answer, otherwise the last
          // successful read from disk. `source` lets the panel say which.
          if (url.searchParams.get('refresh') === '1') {
            adapter.invalidateCatalog()
            // A manual refresh can change what the picker may offer, so the
            // client's cached directory has to be told to re-read.
            notifyModelTopology(ctx)
          }
          const models = await adapter.models()
          const account = await accountIdOf(ctx, region)
  const ledger = readAvailability(region.id, account)
          const imported = readOfficialList(region.id, account)
          const prefs = readPrefs(region.id)
          const dead = unusableModelIds(region.id)
          sendJson(res, 200, {
            region: region.id,
            source: adapter.catalogSource ?? 'none',
            cachedAt: adapter.catalogCachedAt ?? null,
            officialImportedAt: imported?.importedAt ?? null,
            models: models.map((entry) => ({
              id: entry.id,
              name: entry.name,
              preset: entry.preset === true,
              official: entry.official === true,
              imported: entry.imported === true,
              description: typeof entry.descriptionZh === 'string' && entry.descriptionZh.length > 0
                ? entry.descriptionZh
                : entry.descriptionEn,
              descriptionEn: entry.descriptionZh !== undefined ? entry.descriptionEn : undefined,
              credits: entry.credits,
              efforts: entry.efforts === undefined ? [] : Object.keys(entry.efforts),
              defaultEffort: entry.defaultEffort,
              thinking: entry.thinking === true,
              contextWindow: entry.contextWindow,
              maxTokens: entry.maxTokens,
              input: entry.input ?? ['text'],
              requiredUserType: entry.requiredUserType,
              promotion: entry.promotion,
              availability: ledger.models.get(entry.id) ?? null,
              enabled: isEnabled(prefs, entry.id, dead.has(entry.id)),
              // Whether that state is a hand decision or just the verdict.
              decided: prefs.on.has(entry.id) ? 'on' : (prefs.off.has(entry.id) ? 'off' : 'default')
            }))
          })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      /**
       * Turn models on or off in the picker: one id, a list of ids, or every id
       * the panel just showed. Disabled models stay in the panel (greyed) — this
       * only decides what the harness offers.
       */
      if (path === `${API_PREFIX}/enabled` && method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const region = REGIONS[String(body.region ?? '').toLowerCase()]
        if (region === undefined) {
          sendJson(res, 400, { error: `unknown region: ${body.region}` })
          return
        }
        const adapter = adapters[region.id]
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((id) => typeof id === 'string' && id.length > 0)
          : (typeof body.id === 'string' && body.id.length > 0 ? [body.id] : [])
        if (ids.length === 0) {
          sendJson(res, 400, { error: 'expected {"id":"…"} or {"ids":["…"]}' })
          return
        }
        const enabled = body.enabled !== false
        const reset = body.reset === true
        const result = setEnabled(region.id, ids, enabled, { reset })
        const models = adapter === undefined ? [] : await adapter.models()
        const dead = unusableModelIds(region.id)
        const prefs = readPrefs(region.id)
        // The picker caches its catalog until it hears this, so without the
        // notification a model switched off here stays selectable there.
        notifyModelTopology(ctx)
        ctx.logger.info(`[workbuddy] ${region.id}: ${reset ? '恢复默认' : (enabled ? '启用' : '停用')} ${ids.length} 个模型（${ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')}…`}），手工设定 开${result.on}/关${result.off}`)
        sendJson(res, 200, {
          region: region.id,
          saved: result.saved,
          on: result.on,
          off: result.off,
          total: models.length,
          enabledCount: models.filter((entry) => isEnabled(prefs, entry.id, dead.has(entry.id))).length
        })
        return
      }

      /**
       * Open one of the deployment's own site pages in the user's browser.
       *
       * The panel sends a page *name*; the URL comes from `SITE_PAGES`, so this
       * route can never be talked into opening an arbitrary address. The reply
       * carries the URL even when launching failed, so the panel can show it.
       */
      if (path === `${API_PREFIX}/open` && method === 'POST') {
        const body = await readJsonBody(req)
        const region = REGIONS[String(body?.region ?? '').toLowerCase()]
        const url = sitePageUrl(region, body?.page)
        if (url === undefined) {
          sendJson(res, 400, { error: 'unknown region or page' })
          return
        }
        let opened = false
        try {
          opened = (await openInBrowser(url)) !== false
        } catch (error) {
          ctx.logger.warn(`[workbuddy] ${region.id}: 打开 ${url} 失败 — ${error instanceof Error ? error.message : String(error)}`)
        }
        ctx.logger.info(`[workbuddy] ${region.id}: 打开官方页面 ${url}（${opened ? '已交给浏览器' : '启动失败'}）`)
        sendJson(res, 200, { region: region.id, url, opened })
        return
      }

      if (path === `${API_PREFIX}/availability`) {
        const id = String(url.searchParams.get('region') ?? '').toLowerCase()
        const region = REGIONS[id]
        if (region === undefined) {
          sendJson(res, 400, { error: `unknown region: ${id}` })
          return
        }
        const adapter = adapters[region.id]
        if (adapter === undefined) {
          sendJson(res, 400, { error: 'provider route is not mounted' })
          return
        }
        try {
          if (url.searchParams.get('refresh') === '1') {
            // `manual=1` is the panel's button and always runs; without it the
            // sweep is automatic and obeys the deployment's own interval — China
            // may run every time the panel opens, the international one daily.
            const manual = url.searchParams.get('manual') === '1'
            const entries = await adapter.models()
            const ids = entries.map((entry) => entry.id)
            const sweep = ids.length === 0
              ? { skipped: false, results: [] }
              : await runSweep(ctx, region, ids, {
                manual,
                minIntervalMs: region.autoProbeIntervalMs ?? SWEEP_MIN_INTERVAL_MS
              })
            if (sweep.skipped !== true) {
              ctx.logger.info(`[workbuddy] ${region.id}: ${manual ? '手动' : '自动'}可用性检测 ${sweep.results.length} 个${region.freeProbe === true ? '（零消耗）' : '（每个模型一个 token）'} — ${sweep.results.map((result) => `${result.id}=${result.state}`).join(' ')}`)
              for (const result of sweep.results) {
                if (result.state === 'dead' || result.state === 'denied') {
                  ctx.logger.warn(`[workbuddy] ${region.id}: ${result.id} 判定为不可用（${result.detail}）`)
                }
              }
              adapter.invalidateCatalog()
              await adapter.models()
            }
          }
          sendJson(res, 200, {
            region: region.id,
            manual: url.searchParams.get('manual') === '1',
            ...availabilitySummary(region.id),
            ...sweepDue(region.id, region.autoProbeIntervalMs ?? SWEEP_MIN_INTERVAL_MS)
          })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      /**
       * How loaded each model's backend is. The panel asks once per open; the
       * deployment that has no such route simply answers an empty map.
       */
      if (path === `${API_PREFIX}/busy`) {
        const id = String(url.searchParams.get('region') ?? '').toLowerCase()
        const region = REGIONS[id]
        if (region === undefined) {
          sendJson(res, 400, { error: `unknown region: ${id}` })
          return
        }
        try {
          const models = adapters[region.id] === undefined ? [] : await adapters[region.id].models()
          if (url.searchParams.get('refresh') === '1') invalidateBusy(region.id)
          const levels = await fetchBusyLevels(ctx, region, models.map((entry) => entry.id))
          sendJson(res, 200, { region: region.id, levels: Object.fromEntries(levels) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      /**
       * One deployment's credit balance on its own, so the panel can refresh a
       * single row instead of re-reading the whole state payload.
       */
      if (path === `${API_PREFIX}/credits`) {
        const id = String(url.searchParams.get('region') ?? '').toLowerCase()
        const region = REGIONS[id]
        if (region === undefined) {
          sendJson(res, 400, { error: `unknown region: ${id}` })
          return
        }
        try {
          sendJson(res, 200, { region: region.id, credits: await fetchCredits(ctx, region) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      /**
       * The account's own model list, imported from a signed-in web session.
       *
       * The international account endpoint answers a console cookie but not a
       * plugin token (`500`), so the list has to come from a browser capture;
       * posting it here makes it authoritative for that deployment. An empty
       * `models` array clears the import.
       *
       * A `POST` carrying the capture token skips the trust fence (see
       * `isCapturePost`); every other shape of this route stays fenced.
       */
      if (path === `${API_PREFIX}/import`) {
        const id = String(url.searchParams.get('region') ?? '').toLowerCase()
        const region = REGIONS[id]
        // A capture arrives as a "simple request" (text/plain, no preflight), so
        // the browser can send it cross-origin without CORS on our side.
        res.setHeader('access-control-allow-origin', '*')
        if (region === undefined) {
          sendJson(res, 400, { error: `unknown region: ${id}` })
          return
        }
        const adapter = adapters[region.id]
        if (method === 'GET') {
          const list = readOfficialList(region.id, await accountIdOf(ctx, region))
          sendJson(res, 200, {
            region: region.id,
            ids: list?.ids ?? [],
            importedAt: list?.importedAt ?? null,
            from: list?.from ?? null
          })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined || !Array.isArray(body.models)) {
            sendJson(res, 400, { error: 'expected {"models":["…"]}; an empty array clears the imported list' })
            return
          }
          if (body.models.length > 500) {
            sendJson(res, 400, { error: 'model list is implausibly long' })
            return
          }
          const source = typeof body.from === 'string' && body.from.length > 0 ? body.from : 'web-session'
          const result = writeOfficialList(region.id, body.models, { from: source, account: await accountIdOf(ctx, region) })
          adapter?.invalidateCatalog()
          const models = adapter === undefined ? [] : await adapter.models()
          notifyModelTopology(ctx)
          ctx.logger.info(`[workbuddy] ${region.id}: 账号名单${result.cleared === true ? '已清除' : `已导入 ${result.count} 个（其中 ${result.withMeta ?? 0} 个带元数据）`}（${source}），当前列表 ${models.length} 个`)
          sendJson(res, 200, {
            region: region.id,
            saved: result.saved,
            cleared: result.cleared === true,
            count: result.count,
            withMeta: result.withMeta ?? 0,
            total: models.length,
            official: models.filter((entry) => entry.official === true).length
          })
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      if (path === `${API_PREFIX}/checkin` && method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const region = REGIONS[String(body.region ?? '')]
        if (region === undefined) {
          sendJson(res, 400, { error: 'unknown region' })
          return
        }
        const outcome = await claimDailyCheckin(ctx, region)
        const meta = await readMeta(ctx, region)
        if (meta !== undefined) {
          setCredential(region.metaRef, JSON.stringify({
            ...meta,
            checkin: { day: localDayKey(), at: Date.now(), reason: '手动', ...outcome }
          }))
        }
        sendJson(res, 200, { region: region.id, ...outcome, ...(await statePayload(ctx, adapters)) })
        return
      }

      if ((path === `${API_PREFIX}/login` || path === `${API_PREFIX}/logout` || path === `${API_PREFIX}/refresh`) && method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined) {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const region = REGIONS[String(body.region ?? '')]
        if (region === undefined) {
          sendJson(res, 400, { error: 'unknown region' })
          return
        }
        if (path.endsWith('/login')) {
          try {
            const result = await beginLogin(ctx, region, {
              onSuccess: () => adapters[region.id]?.invalidateCatalog()
            })
            sendJson(res, 200, { region: region.id, url: result.url, pending: result.pending })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (path.endsWith('/logout')) {
          await logoutRegion(ctx, region)
          adapters[region.id]?.invalidateCatalog()
          notifyModelTopology(ctx)
          sendJson(res, 200, await statePayload(ctx, adapters))
          return
        }
        const result = await refreshRegion(ctx, region, { force: true })
        sendJson(res, 200, { region: region.id, ...result })
        return
      }

      // Naming the path here matters: the host keeps serving the *first*
      // registration it got, so after a reload a request can still land on an
      // older build that simply does not know the route (that is exactly how a
      // missing `/credits` shows up as `not found` in the panel).
      ctx.logger?.warn?.(`[workbuddy] 未匹配的面板请求 ${method} ${path}（当前挂载的是 ${CODE_STAMP}）`)
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      ctx.logger?.warn?.(`[workbuddy] API ${method} ${path} failed — ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.logger?.info?.(`[workbuddy] 面板路由已挂载（${CODE_STAMP}）`)
  return ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
}

