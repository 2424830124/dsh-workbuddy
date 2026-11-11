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

import { accountOf, beginLogin, cancelLogin, logoutRegion, pendingAccounts, pendingLoginFor, pendingLogins, prefsFor, readMeta, readToken, refreshRegion, regionStatus, slotKey, usableSlot } from '../account/auth.js'
import { accountSlots, listAccounts, newAccountId, slotFor } from '../account/pool.js'
import { invalidateBusy, fetchBusyLevels } from '../catalog/busy.js'
import { SWEEP_MIN_INTERVAL_MS, aggregateAvailability, runSweep, sweepDue } from '../catalog/availability.js'
import { claimDailyCheckin, fetchCheckinStatus, fetchCredits } from '../account/credits.js'
import { localDayKey } from '../core/http.js'
import { isEnabled, setEnabled } from '../catalog/model-prefs.js'
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
  const { openInBrowser } = await import('../core/regions.js')
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

/**
 * The account table's payload.
 *
 * The two deployments are read **in parallel**: each side costs a credits call and a
 * check-in call, and doing them in sequence made every `/state` as slow as the sum of four
 * round trips (346 ms measured) — which the panel feels on every action, and a model switch
 * does not even need this payload.
 *
 * Within one deployment the accounts are read in parallel for the same reason, and the
 * deployment-level fields are aggregated: `credits` is the sum over its accounts (that is
 * what the row shows), `loggedIn` is true when at least one account can be called, and
 * the first signed-in account still answers the top-level `nickname`/`expiresAt` the way a
 * single-account panel expected. `accounts` carries the detail, in fallback order — and
 * only the accounts that really exist, i.e. the ones holding credentials. The panel draws a
 * row per entry, so an entry nobody can read a token for can only ever read 未知 / 未登录,
 * cannot be called and cannot be signed out; a deployment with no account left answers with
 * an empty list and the panel says so instead of drawing that row.
 */
async function statePayload(ctx, adapters) {
  const regions = await Promise.all(REGION_IDS.map(async (id) => {
    const region = REGIONS[id]
    const pendingFlow = pendingLoginFor(region)
    const slots = accountSlots(region)
    const accounts = (await Promise.all(slots.map(async (slot) => {
      const [status, meta, token] = await Promise.all([regionStatus(ctx, slot), readMeta(ctx, slot), readToken(ctx, slot)])
      const signedIn = token.length > 0
      let credits = null
      let checkin = null
      if (signedIn) {
        const [creditResult, checkinResult] = await Promise.all([
          fetchCredits(ctx, slot).catch((error) => ({ supported: true, ok: false, reason: String(error?.message ?? error) })),
          fetchCheckinStatus(ctx, slot).catch((error) => ({ supported: true, ok: false, reason: String(error?.message ?? error) }))
        ])
        credits = creditResult
        checkin = checkinResult
      }
      return {
        id: accountOf(slot),
        nickname: typeof meta?.nickname === 'string' ? meta.nickname : '',
        // `status.loggedIn` is the expiry-aware answer, which is what the row shows: a
        // token that is still present but already past its expiry reads 已过期, exactly
        // as it did when a deployment held a single account.
        loggedIn: status.loggedIn,
        hasToken: signedIn,
        expiresAt: typeof meta?.expiresAt === 'number' ? meta.expiresAt : 0,
        refreshable: typeof meta?.refreshToken === 'string' && meta.refreshToken.length > 0,
        pending: pendingLogins.has(slotKey(slot)),
        credits,
        checkin,
        lastClaim: typeof meta?.checkin === 'object' && meta.checkin !== null ? meta.checkin : null
      }
    }))).filter((entry) => entry.hasToken === true)

    let models = 0
    let modelsSource = null
    let modelsCachedAt = null
    const anyToken = accounts.some((entry) => entry.hasToken)
    if (anyToken && adapters[id] !== undefined) {
      try {
        models = (await adapters[id].models()).length
        modelsSource = adapters[id].catalogSource ?? null
        modelsCachedAt = adapters[id].catalogCachedAt ?? null
      } catch {
        models = 0
      }
    }

    // The sums the rows show. A balance that could not be read is `null`, never 0 — the
    // difference between "empty" and "unknown" is the whole point of the credit column.
    let total = 0
    let known = 0
    let daily = 0
    for (const entry of accounts) {
      if (entry.credits?.ok !== true || typeof entry.credits.total !== 'number') continue
      total += entry.credits.total
      known += 1
      if (typeof entry.credits.daily === 'number') daily += entry.credits.daily
    }
    const credits = known === 0 ? null : { supported: true, ok: true, total: round2(total), daily: round2(daily), accounts: known }
    const first = accounts.find((entry) => entry.loggedIn)
    const checkin = accounts.find((entry) => entry.checkin !== null)?.checkin ?? null

    return {
      id,
      label: region.label,
      provider: region.provider,
      endpoint: region.endpoint,
      loggedIn: accounts.some((entry) => entry.loggedIn),
      // Asked of the in-flight logins rather than of the listed accounts: the account being
      // added does not exist yet, so a login started for it is keyed `cn:<new id>` and no
      // entry in this payload would ever say `pending`. The panel polls while a deployment is
      // pending, so answering "no" here is what left a freshly added account invisible until
      // the user reloaded the page by hand.
      pending: pendingAccounts(region),
      // The pending flow belongs to the host: it minted the URL and it runs the poll that will
      // finish it. Publishing both here is what lets the panel show the link again after a
      // reload — it may only have kept it in memory, and then a 等待授权… with nothing to click
      // and no way out was all it could draw.
      loginUrl: pendingFlow?.url !== undefined && pendingFlow.url.length > 0 ? pendingFlow.url : null,
      pendingSince: pendingFlow?.startedAt ?? null,
      // Kept for consumers that still speak the single-account shape (the state service,
      // the picker's own row): the first signed-in account answers for the deployment.
      nickname: first?.nickname ?? accounts[0]?.nickname ?? '',
      expiresAt: first?.expiresAt ?? accounts[0]?.expiresAt ?? 0,
      refreshable: accounts.some((entry) => entry.refreshable),
      models,
      modelsSource,
      modelsCachedAt,
      hasBusy: region.hasBusy === true,
      credits,
      checkin,
      lastClaim: first?.lastClaim ?? accounts[0]?.lastClaim ?? null,
      accounts
    }
  }))
  return { regions }
}

const round2 = (value) => Math.round(value * 100) / 100

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
          const slot = usableSlot(region)
          const account = accountOf(slot)
          const ledger = aggregateAvailability(region.id, listAccounts(region).map((entry) => entry.id))
          const imported = readOfficialList(region.id, account)
          const prefs = prefsFor(region)
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
              enabled: isEnabled(prefs, entry.id),
              // On by the user's choice, but the sweep has it out of the way until it
              // answers again. The panel words the hint from this; the switch itself stays
              // their answer, which is what makes the recovery put it back unchanged.
              autoOff: prefs.autoOff.has(entry.id),
              // `on` means the user turned it on; everything else is the default, which is
              // off. The panel keeps the distinction to word the hint, not to change the state.
              decided: prefs.enabled.has(entry.id) ? 'on' : 'default'
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
        // Read back through `prefsFor`, so the count the caller is told is the same count
        // the picker will offer — including any model the sweep has suspended.
        const prefs = prefsFor(region)
        // The picker caches its catalog until it hears this, so without the
        // notification a model switched off here stays selectable there.
        notifyModelTopology(ctx)
        ctx.logger.info(`[workbuddy] ${region.id}: ${reset ? '恢复默认（全部停用）' : (enabled ? '启用' : '停用')} ${ids.length} 个模型（${ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')}…`}），当前启用 ${result.on} 个`)
        sendJson(res, 200, {
          region: region.id,
          saved: result.saved,
          on: result.on,
          total: models.length,
          enabledCount: models.filter((entry) => isEnabled(prefs, entry.id)).length
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
            // Every account is probed, because the list answers "can this deployment call
            // the model" and one account may be allowed what another is denied. Probing only
            // the primary would leave a model the second account can call showing as
            // unusable, which is the same wrong answer the aggregate exists to prevent.
            const results = []
            for (const slot of accountSlots(region)) {
              if (ids.length === 0) break
              const sweep = await runSweep(ctx, slot, ids, {
                manual,
                minIntervalMs: region.autoProbeIntervalMs ?? SWEEP_MIN_INTERVAL_MS
              })
              if (sweep.skipped === true) continue
              results.push(...sweep.results)
              for (const result of sweep.results) {
                if (result.state === 'dead' || result.state === 'denied') {
                  ctx.logger.warn(`[workbuddy] ${slotKey(slot)}: ${result.id} 判定为不可用（${result.detail}）`)
                }
              }
            }
            if (ids.length > 0 && results.length === 0) {
              ctx.logger.info(`[workbuddy] ${region.id}: ${manual ? '手动' : '自动'}可用性检测已跳过（未到间隔）`)
            } else if (results.length > 0) {
              ctx.logger.info(`[workbuddy] ${region.id}: ${manual ? '手动' : '自动'}可用性检测 ${results.length} 个${region.freeProbe === true ? '（零消耗）' : '（每个模型一个 token）'} — ${results.map((result) => `${result.id}=${result.state}`).join(' ')}`)
              adapter.invalidateCatalog()
              await adapter.models()
            }
          }
          // The counts are the aggregate the panel's chips show: one account's `denied`
          // must not be reported as the deployment's verdict when a sibling can call the
          // model. `sweepDue` is asked of the first account, because that is the one the
          // automatic sweep runs for first and therefore the one whose timestamp decides.
          const accountIds = listAccounts(region).map((entry) => entry.id)
          const summary = aggregateAvailability(region.id, accountIds)
          sendJson(res, 200, {
            region: region.id,
            manual: url.searchParams.get('manual') === '1',
            ...summary,
            models: [...summary.models.entries()].map(([id, entry]) => ({ id, ...entry })),
            ...sweepDue(region.id, region.autoProbeIntervalMs ?? SWEEP_MIN_INTERVAL_MS, Date.now(), accountIds[0])
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
          // The adapters are registered by `apply()` for both deployments at once, so one
          // cannot be missing here without the whole plugin having failed to load.
          const models = await adapters[region.id].models()
          if (url.searchParams.get('refresh') === '1') invalidateBusy(region.id)
          const levels = await fetchBusyLevels(ctx, region, models.map((entry) => entry.id))
          sendJson(res, 200, { region: region.id, levels: Object.fromEntries(levels) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      /**
       * One account's (or one deployment's) credit balance on its own, so the panel can
       * refresh a single row instead of re-reading the whole state payload.
       *
       * `account` names the account to read; without it the deployment's current account
       * answers, and the result carries that account's id so a caller can tell which one
       * the number came from.
       */
      if (path === `${API_PREFIX}/credits`) {
        const id = String(url.searchParams.get('region') ?? '').toLowerCase()
        const region = REGIONS[id]
        if (region === undefined) {
          sendJson(res, 400, { error: `unknown region: ${id}` })
          return
        }
        const named = url.searchParams.get('account')
        const slot = named === null ? usableSlot(region) : slotFor(region, named)
        try {
          sendJson(res, 200, { region: region.id, account: accountOf(slot), credits: await fetchCredits(ctx, slot) })
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
          const list = readOfficialList(region.id, accountOf(usableSlot(region)))
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
          // The capture is one account's entitlement, and the file is per account now, so
          // the account has to be named. Without one it lands on the account the
          // deployment is currently using — the same account the panel would show.
          const target = typeof body.account === 'string' && body.account.length > 0
            ? slotFor(region, body.account)
            : usableSlot(region)
          const result = writeOfficialList(region.id, body.models, { from: source, account: accountOf(target) })
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
        const slot = slotFor(region, body.account === undefined ? accountOf(usableSlot(region)) : String(body.account))
        const outcome = await claimDailyCheckin(ctx, slot)
        const meta = await readMeta(ctx, slot)
        if (meta !== undefined) {
          setCredential(slot.metaRef, JSON.stringify({
            ...meta,
            checkin: { day: localDayKey(), at: Date.now(), reason: '手动', ...outcome }
          }))
        }
        sendJson(res, 200, { region: region.id, account: accountOf(slot), ...outcome, ...(await statePayload(ctx, adapters)) })
        return
      }

      /**
       * Remove one account from a deployment.
       *
       * A dedicated route rather than a flag on `/logout`, because removing is the
       * destructive direction: `/logout` signs the primary account out and that is what a
       * single-account install has always meant, while this one deletes a named account and
       * leaves its siblings alone.
       */
      if (path === `${API_PREFIX}/accounts/remove` && method === 'POST') {
        const body = await readJsonBody(req)
        const region = REGIONS[String(body?.region ?? '')]
        if (region === undefined) {
          sendJson(res, 400, { error: 'unknown region' })
          return
        }
        const account = String(body.account ?? '')
        if (account.length === 0) {
          sendJson(res, 400, { error: 'expected {"account":"…"}' })
          return
        }
        const slot = slotFor(region, account)
        await logoutRegion(ctx, slot)
        adapters[region.id]?.invalidateCatalog()
        notifyModelTopology(ctx)
        sendJson(res, 200, await statePayload(ctx, adapters))
        return
      }

      if ((path === `${API_PREFIX}/login` || path === `${API_PREFIX}/login/cancel` || path === `${API_PREFIX}/logout` || path === `${API_PREFIX}/refresh`) && method === 'POST') {
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
        /**
         * Which account the action is about.
         *
         * `add: true` is 添加账号: a brand-new account is appended to the pool, so it lands
         * last in the fallback order and does not silently take over requests the existing
         * accounts were serving. Everything else names an account, or leaves it out to mean
         * "whichever account this deployment is currently using".
         */
        const slot = body.add === true
          ? slotFor(region, newAccountId(Date.now()))
          : slotFor(region, body.account === undefined ? accountOf(usableSlot(region)) : String(body.account))
        if (path.endsWith('/login/cancel')) {
          // Abandoning a flow the user no longer wants (or clicked 添加账号 twice for). The
          // panel offers it from the callout, which used to be a dead end: a login that was
          // never finished stayed on screen until the 5-minute poll timed out.
          const result = cancelLogin(region, body.account === undefined ? undefined : String(body.account))
          ctx.logger.info(`[workbuddy] ${region.id}: 已取消 ${result.cancelled} 个进行中的登录`)
          sendJson(res, 200, { region: region.id, ...result, ...(await statePayload(ctx, adapters)) })
          return
        }
        if (path.endsWith('/login')) {
          try {
            const result = await beginLogin(ctx, slot, {
              // `add` means "this is a new account", so the poll must not fold the result
              // into the slot it was given: the id is decided when the token arrives.
              fresh: body.add === true,
              onSuccess: (stored) => {
                // Runs once the poll has the token, which is after this request has already
                // answered. The picker's catalog is cached until it hears the topology event,
                // so without this the newly reachable models stay invisible until something
                // else happens to notify it — measured: the log showed the account signing in
                // and its models arriving, but the notification only appearing at logout.
                adapters[region.id]?.invalidateCatalog()
                notifyModelTopology(ctx)
                // The account that was written, which for 添加账号 is decided by the poll and
                // is therefore not known here. Both of these are per account: probing the
                // deployment would leave the new account without verdicts, and claiming for
                // the wrong one would take credits the new account is owed.
                const written = slotFor(region, stored.account)
                const live = adapters[region.id]
                void (async () => {
                  try {
                    const entries = await live?.models()
                    if (live !== undefined && (entries?.length ?? 0) > 0) {
                      await runSweep(ctx, written, entries.map((entry) => entry.id), { manual: true })
                      live.invalidateCatalog()
                      notifyModelTopology(ctx)
                    }
                  } catch { /* a failed probe must not break the login it followed */ }
                })()
                void claimDailyCheckin(ctx, written).then((outcome) => {
                  if (outcome.claimed) ctx.logger.info(`[workbuddy] ${slotKey(written)}: 登录后签到成功，获得 ${outcome.credit ?? 0} 积分`)
                }).catch(() => {})
              }
            })
            sendJson(res, 200, { region: region.id, account: accountOf(slot), add: body.add === true, url: result.url, pending: result.pending })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (path.endsWith('/logout')) {
          await logoutRegion(ctx, slot)
          adapters[region.id]?.invalidateCatalog()
          notifyModelTopology(ctx)
          sendJson(res, 200, await statePayload(ctx, adapters))
          return
        }
        const result = await refreshRegion(ctx, slot, { force: true })
        // A renewed credential can make a previously rejected catalog readable, and the
        // picker only re-reads when it hears this.
        if (result.refreshed === true) notifyModelTopology(ctx)
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

