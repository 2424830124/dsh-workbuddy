/**
 * dsh-workbuddy — WorkBuddy model provider for DeepSeek Harness.
 *
 * Registers one llm provider route per WorkBuddy deployment:
 *
 *   workbuddy-intl → https://www.workbuddy.ai  (login platform: workbuddy-ai)
 *   workbuddy-cn   → https://www.workbuddy.cn  (login platform: workbuddy)
 *
 * and the `/workbuddy` command that signs each one in, reports status, rotates
 * tokens, and lists the live account catalog. `auth.js` owns the plugin login
 * protocol, `adapter.js` the OpenAI-compatible wire, `catalog.js` the static
 * fallback catalogs, `api.js` the Settings panel's HTTP surface, and
 * `client.js` the panel itself.
 */

import { randomUUID } from 'node:crypto'

import { WorkBuddyAdapter } from './llm/adapter.js'
import { registerWorkbuddyApi } from './panel/api.js'
import { REFRESH_BOOT_DELAY_MS, REFRESH_INTERVAL_MS, beginLogin, logoutRegion, refreshRegion, regionStatus } from './account/auth.js'
import { runSweep, sweepDue } from './catalog/availability.js'
import { claimDailyCheckin, runAutoClaim } from './account/credits.js'
import { msUntilNextMidnight } from './core/http.js'
import { readPrefs } from './catalog/model-prefs.js'
import { REGIONS, REGION_IDS, regionList } from './core/regions.js'
import { notifyModelTopology } from './core/topology.js'

export const name = 'dsh-workbuddy'
export const inject = ['commands', 'credentials', 'llm']

/** Startup claim runs a little after the rest of the plugin has settled. */
const CHECKIN_BOOT_DELAY_MS = 15_000

async function executeCommand(ctx, adapters, invocation) {
  const input = String(invocation.rawInput ?? '').trim()
  const [verbRaw, argRaw] = input.split(/\s+/)
  const verb = (verbRaw ?? '').toLowerCase()

  if (verb === '' || verb === 'status') {
    const lines = []
    for (const region of REGION_IDS.map((id) => REGIONS[id])) lines.push((await regionStatus(ctx, region)).text)
    lines.push('', '命令：/workbuddy login [intl|cn|all]、logout [intl|cn|all]、status、models [intl|cn]、check [intl|cn] [all]、refresh [intl|cn]')
    return { kind: 'success', text: lines.join('\n') }
  }

  const regions = regionList(argRaw)
  if (regions.length === 0) {
    return { kind: 'error', text: `未知区域 "${argRaw}"。请使用 intl、cn 或 all。` }
  }

  if (verb === 'login') {
    const lines = []
    for (const region of regions) {
      try {
        const result = await beginLogin(ctx, region, {
          onSuccess: async () => {
            adapters[region.id]?.invalidateCatalog()
            // The availability ledger belongs to the account, so a new login starts with
            // no verdicts: probe this account once, which is how "which models can this
            // account use" gets answered (the catalog itself stays shared).
            void probeAccount(region)
            // A fresh account usually has today's check-in waiting.
            void claimDailyCheckin(ctx, region).then(async (outcome) => {
              if (outcome.claimed) ctx.logger.info(`[workbuddy] ${region.id}: 登录后签到成功，获得 ${outcome.credit ?? 0} 积分`)
            }).catch(() => {})
          }
        })
        lines.push(`${region.label}：${result.pending ? '已有登录在进行中' : '已打开授权页面'}`)
        lines.push(`  ${result.url}`)
      } catch (error) {
        lines.push(`${region.label}：启动登录失败 — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    lines.push('', '请在浏览器中完成授权；令牌会自动写入。可用 /workbuddy status 查看结果。')
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'logout') {
    const lines = []
    for (const region of regions) {
      await logoutRegion(ctx, region)
      adapters[region.id]?.invalidateCatalog()
      notifyModelTopology(ctx)
      lines.push(`${region.label}：凭据已清除`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'refresh') {
    const lines = []
    for (const region of regions) {
      const result = await refreshRegion(ctx, region, { force: true })
      lines.push(`${region.label}：${result.refreshed ? '已续期' : `未续期（${result.reason}）`}`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'models') {
    const lines = []
    for (const region of regions) {
      const adapter = adapters[region.id]
      if (adapter === undefined) {
        lines.push(`${region.label}：provider 路由未挂载`)
        continue
      }
      adapter.invalidateCatalog()
      const models = await adapter.models()
      const source = adapter.catalogSource === 'scoped'
        ? '实时目录'
        : adapter.catalogSource === 'config'
          ? '实时目录（/v3/config）'
          : adapter.catalogSource === 'cache'
            ? `本地缓存（${adapter.catalogCachedAt === undefined ? '时间未知' : new Date(adapter.catalogCachedAt).toLocaleString()}）`
            : '取不到（无实时源且无缓存）'
      lines.push(`${region.label}：${models.length} 个模型（来源：${source}）`)
      lines.push(models.map((model) => `  ${model.id}${model.name.length > 0 ? ` — ${model.name}` : ''}`).join('\n'))
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  /**
   * Probe the catalog: the catalog cannot tell a usable model from a delisted
   * one, so a minimal request per model answers it. Non-whitelisted models are
   * probed by default (they are the ones in question); `all` widens it.
   */
  if (verb === 'check') {
    const lines = []
    // A check typed by hand always runs; only the boot sweep obeys the daily limit.
    for (const region of regions) {
      const adapter = adapters[region.id]
      if (adapter === undefined) {
        lines.push(`${region.label}：provider 路由未挂载`)
        continue
      }
      adapter.invalidateCatalog()
      const targets = await adapter.models()
      if (targets.length === 0) {
        lines.push(`${region.label}：没有可检测的模型`)
        continue
      }
      lines.push(`${region.label}：检测 ${targets.length} 个模型…`)
      const sweep = await runSweep(ctx, region, targets.map((model) => model.id), { manual: true })
      for (const result of sweep.results) {
        lines.push(`  ${result.id} — ${result.state}${result.detail.length > 0 ? `（${result.detail}）` : ''}`)
      }
      const counts = new Map()
      for (const result of sweep.results) counts.set(result.state, (counts.get(result.state) ?? 0) + 1)
      lines.push(`  结果：${[...counts.entries()].map(([state, count]) => `${state} ${count}`).join(' / ')}`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  return { kind: 'error', text: `未知子命令 "${verb}"。请使用 login、logout、status、models、check 或 refresh。` }
}

export function apply(ctx) {
  // Every load gets a short tag: the host can hold more than one instance alive
  // across reloads, and their timers then interleave in the log.
  const instance = randomUUID().slice(0, 4)
  /** @type {Record<string, WorkBuddyAdapter>} */
  const adapters = {}
  for (const id of REGION_IDS) {
    const region = REGIONS[id]
    const adapter = new WorkBuddyAdapter(ctx, region)
    adapters[id] = adapter
    ctx.llm.registerAdapter([region.provider], adapter)
  }

  ctx.commands.register({
    definitionId: 'dsh-workbuddy',
    name: 'workbuddy',
    description: '登录 WorkBuddy（海外版/大陆版）并管理其模型路由',
    input: { hint: '[login|logout|status|models|refresh] [intl|cn|all]' },
    handler: (invocation) => executeCommand(ctx, adapters, invocation)
  })

  // Settings panel surface. Optional: a composition without an HTTP carrier
  // (headless runs) keeps the provider routes and the command.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerWorkbuddyApi(webCtx, adapters), 'dsh-workbuddy: /workbuddy HTTP routes')
  })

  // Boot sweep: rotate anything close to expiry so the first model call after a
  // restart does not race a stale token. Delayed and unref'd so plugin load
  // stays free of network I/O.
  const bootTimer = setTimeout(() => {
    ctx.logger.info(`[workbuddy] 启动定时器触发（实例 ${instance}）`)
    for (const id of REGION_IDS) {
      // Same reason as the sweep: a token can be retired while the app was closed, and the
      // claim will still say it is good for weeks.
      void refreshRegion(ctx, REGIONS[id], { rotate: true }).catch((error) => {
        ctx.logger.warn(`[workbuddy] ${id}: 启动续期失败 — ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    // What the model picker will actually be offered, straight from the surface
    // the harness reads: the panel's catalog can be healthy while this list is
    // not, and the two are easy to confuse when a picker looks empty.
    void (async () => {
      for (const id of REGION_IDS) {
        const adapter = adapters[id]
        const region = REGIONS[id]
        try {
          const catalog = await adapter.models()
          const audit = await adapter.auditPicker(region.provider)
          ctx.logger.info(`[workbuddy] ${id}: 选择器可选项 ${audit.models} 个（目录 ${catalog.length} 个，provider ${region.provider}）`)
          for (const problem of audit.problems) {
            ctx.logger.error(`[workbuddy] ${id}: 选择器契约违规 — ${problem}`)
          }
          if (audit.models === 0 && catalog.length > 0) {
            const prefs = readPrefs(id)
            ctx.logger.warn(`[workbuddy] ${id}: 目录有模型但选择器为空 — 手工开关 开${prefs.on.size}/关${prefs.off.size}，请在面板里检查「全部启用」与每行开关`)
          }
        } catch (error) {
          ctx.logger.error(`[workbuddy] ${id}: 列举选择器模型失败 — ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()
  }, REFRESH_BOOT_DELAY_MS)
  bootTimer.unref?.()

  // Rotate on the sweep's own cadence rather than "when the claim says it is close": the
  // claim is an upper bound the server does not honour (see REFRESH_INTERVAL_MS).
  const sweep = setInterval(() => {
    for (const id of REGION_IDS) {
      void refreshRegion(ctx, REGIONS[id], { rotate: true }).catch(() => {})
    }
  }, REFRESH_INTERVAL_MS)
  sweep.unref?.()

  // Daily check-in: once shortly after startup, then once at every local
  // midnight. The claim is idempotent server-side (code 10001), so an extra
  // run after a restart costs one request and never double-credits.
  let midnightTimer
  const scheduleMidnightClaim = () => {
    midnightTimer = setTimeout(() => {
      void runAutoClaim(ctx, '午夜').catch(() => {})
      scheduleMidnightClaim()
    }, msUntilNextMidnight())
    midnightTimer.unref?.()
  }

  const claimTimer = setTimeout(() => {
    void runAutoClaim(ctx, '启动').catch(() => {})
  }, CHECKIN_BOOT_DELAY_MS)
  claimTimer.unref?.()
  scheduleMidnightClaim()

  // Automatic availability sweep, on each deployment's own interval: China may
  // run every time the panel opens (its probe never generates), the
  // international one once a day (its probe costs a token per model).
  const AVAILABILITY_BOOT_DELAY_MS = 45_000
  /** Probe every model once for the account that just logged in. */
  const probeAccount = async (region) => {
    const adapter = adapters[region.id]
    if (adapter === undefined) return
    try {
      adapter.invalidateCatalog()
      const entries = await adapter.models()
      if (entries.length === 0) return
      const result = await runSweep(ctx, region, entries.map((entry) => entry.id), { manual: true })
      if (result.skipped === true) return
      const counts = new Map()
      for (const verdict of result.results) counts.set(verdict.state, (counts.get(verdict.state) ?? 0) + 1)
      ctx.logger.info(`[workbuddy] ${region.id}: 登录后可用性检测完成 ${result.results.length} 个 — ${[...counts.entries()].map(([state, count]) => `${state} ${count}`).join(' / ')}`)
      notifyModelTopology(ctx)
    } catch (error) {
      ctx.logger.warn(`[workbuddy] ${region.id}: 登录后可用性检测失败 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const availabilityTimer = setTimeout(() => {
    for (const id of REGION_IDS) {
      const region = REGIONS[id]
      const adapter = adapters[id]
      if (adapter === undefined) continue
      const interval = region.autoProbeIntervalMs ?? 24 * 3600_000
      if (sweepDue(id, interval).due !== true) continue
      void (async () => {
        adapter.invalidateCatalog()
        const entries = await adapter.models()
        if (sweepDue(id, interval).due !== true || entries.length === 0) return
        const result = await runSweep(ctx, region, entries.map((entry) => entry.id), { minIntervalMs: interval })
        if (result.skipped === true) return
        const counts = new Map()
        for (const verdict of result.results) counts.set(verdict.state, (counts.get(verdict.state) ?? 0) + 1)
        ctx.logger.info(`[workbuddy] ${id}: 启动可用性检测完成 ${result.results.length} 个${region.freeProbe === true ? '（零消耗）' : '（每个模型一个 token）'} — ${[...counts.entries()].map(([state, count]) => `${state} ${count}`).join(' / ')}`)
        adapter.invalidateCatalog()
        // Verdicts decide the default on/off state, so tell the picker to re-read.
        notifyModelTopology(ctx)
      })().catch((error) => {
        ctx.logger.warn(`[workbuddy] ${id}: 启动可用性检测失败 — ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }, AVAILABILITY_BOOT_DELAY_MS)
  availabilityTimer.unref?.()

  /**
   * Retry log.
   *
   * The retry itself belongs to `@deepseek-ai/dsh-llm-retry`, which appends
   * `llm/retry` to the session; nothing prints it, so a step that failed three
   * times and then succeeded looks identical to one that succeeded first try.
   * Logging the decision keeps a truncated answer visible even when the retry
   * hides it — which is exactly the case that used to be reported as a clean stop.
   */
  ctx.effect(() => {
    const byProvider = new Map(Object.values(REGIONS).map((region) => [region.provider, region]))
    const off = ctx.on('session/event', (_session, event) => {
      if (event?.type !== 'llm/retry') return
      const region = byProvider.get(event.data?.provider)
      if (region === undefined) return
      const failure = event.data?.failure ?? {}
      const delay = typeof event.data?.delayMs === 'number' ? `${(event.data.delayMs / 1000).toFixed(1)}s` : '未知延迟'
      const message = String(failure.message ?? '').replace(/\s+/g, ' ').slice(0, 200)
      ctx.logger.warn(`[workbuddy] ${region.id}: 第 ${event.data?.retry ?? '?'}/${event.data?.maxRetries ?? '?'} 次重试（${failure.code ?? '未知'}）${message.length > 0 ? ` — ${message}` : ''}；${delay} 后重试`)
    })
    return () => { if (typeof off === 'function') off() }
  }, 'dsh-workbuddy: retry log')

  ctx.effect(() => () => {
    ctx.logger.info(`[workbuddy] 定时器全部撤销（实例 ${instance}）`)
    clearTimeout(bootTimer)
    clearInterval(sweep)
    clearTimeout(claimTimer)
    clearTimeout(availabilityTimer)
    clearTimeout(midnightTimer)
  }, 'dsh-workbuddy: token refresh and check-in timers')

  ctx.logger.info(`[workbuddy] 已注册 provider：workbuddy-intl、workbuddy-cn；请运行 /workbuddy login 授权（实例 ${instance}）`)
}
