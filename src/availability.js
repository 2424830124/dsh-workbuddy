/**
 * Availability ledger: which models actually answer.
 *
 * The catalog cannot tell a usable model from a delisted one. China lists
 * `glm-4.6`, `glm-4.7`, `glm-5.0`, `minimax-m2.5`, `kimi-k2-thinking`,
 * `hy4-preview-x` and `hunyuan-2.0-thinking` with a current credits rate, and
 * every one of them answers `400 11102 model [...] service info not found`; the
 * `POST /v2/chat/busy` endpoint is no help either (models outside the active
 * set are `unknown`, usable or not). The only reliable signal is a request, and
 * the probe is built to cost nothing: it sends a **parameter-invalid** request
 * (`messages: []`), which the gateway rejects in two distinguishable ways —
 *
 * - the model is gone → the registry lookup fails first → `400 11102`
 * - the model exists → the request reaches the parameter layer → `400 11133`
 *
 * Measured 2026-10-21: 8/8 live models answered `11133`, 3/3 delisted models
 * answered `11102`, no misclassification, 130–700 ms per probe, and **no
 * completion is ever started**. (A cancelled `max_tokens: 1` probe also moved
 * the credits balance by 0.00, but this shape stays free no matter how billing
 * treats a cancelled stream.)
 *
 * Verdicts live in `$DSH_HOME/cache/dsh-workbuddy/availability-<region>.json`
 * keyed by model id, and the catalog drops ids whose last probe said `dead`
 * until that verdict ages out.
 *
 * The verdict is also learned for free: when a real chat turn fails with
 * `11102`, the adapter records it here, so a model that dies mid-session stops
 * being advertised without waiting for a sweep.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readToken } from './auth.js'
import { chatRoutes } from './regions.js'

const LEDGER_VERSION = 1
/** How long a probe verdict is trusted before the model is swept again. */
export const AVAILABILITY_TTL_MS = 12 * 3600_000
const PROBE_CONCURRENCY = 3
const PROBE_TIMEOUT_MS = 30_000

/** States that keep a model out of the picker by default. */
const UNUSABLE_STATES = new Set(['dead', 'denied'])

function ledgerDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-workbuddy')
}

function ledgerPath(regionId) {
  return join(ledgerDir(), `availability-${regionId}.json`)
}

/**
 * Read one *probe* response as a verdict.
 *
 * The probe deliberately sends an invalid request, so a healthy model answers
 * `400` rather than `200`: reaching the parameter layer is itself the proof that
 * the model is routed. Two rejections show up in practice —
 *
 * - `11133 the request parameters were rejected by the model provider`
 * - `11151 a message has empty content` (`hy3` / `hy3-x` validate the
 *   conversation before the provider gets to it)
 *
 * — and any other 4xx is read the same way, because `11102` is the only answer
 * that means "this model is gone". Filling the context with a placeholder
 * instead was measured and rejected: the models then answer for real (`200`,
 * tokens generated), which is exactly what this probe exists to avoid.
 *
 * Queueing, channel blocks, credential problems and 5xx are states a later
 * attempt can change, so they are recorded for display but never hide a model.
 */
export function classifyProbe(status, body) {
  const text = typeof body === 'string' ? body : ''
  if (/11102|service info not found/i.test(text)) {
    // The same code carries two meanings: a missing id, and an id that exists but
    // is gated. China answers `11102 model [gpt-5.3-codex] is only available for
    // authorized users`, which is a permission answer, not a missing model.
    if (/authorized users|not authorized|unauthorized/i.test(text)) {
      const message = /"msg":"([^"]{0,60})/.exec(text)?.[1] ?? ''
      return { state: 'denied', detail: `账号无权限（11102${message.length > 0 ? ` ${message}` : ''}）` }
    }
    return { state: 'dead', detail: '模型不存在（11102 service info not found）' }
  }
  if (/11158|is not allowed for user type/i.test(text)) {
    const type = /user type \[([^\]]{0,40})\]/i.exec(text)?.[1] ?? ''
    return { state: 'denied', detail: `账号无权限（11158${type.length > 0 ? `，用户类型 ${type}` : ''}）` }
  }
  if (/11133|rejected by the model provider|Invalid request parameters/i.test(text)) {
    return { state: 'ok', detail: '模型存在（探测请求未产生消耗）' }
  }
  if (/11151|message has empty content/i.test(text)) {
    return { state: 'ok', detail: '模型存在（探测请求未产生消耗）' }
  }
  if (/6020|queue\.waiting/i.test(text)) return { state: 'busy', detail: '模型排队中（可用但繁忙）' }
  if (/11128|unapproved channel|request illegal|first message is not system/i.test(text)) {
    return { state: 'blocked', detail: `请求被网关拒绝（11128 ${/"(?:msg|error_description)":"([^"]{0,40})/.exec(text)?.[1] ?? ''}）` }
  }
  if (status === 401 || status === 403) return { state: 'auth', detail: `凭据被拒（HTTP ${status}）` }
  if (status >= 500) return { state: 'down', detail: `上游故障（HTTP ${status}）` }
  if (status === 429) return { state: 'busy', detail: '限流（HTTP 429）' }
  if (status === 200) return { state: 'ok', detail: '' }
  if (status >= 400 && status < 500) {
    const message = /"msg":"([^"]{0,60})/.exec(text)?.[1] ?? ''
    return { state: 'ok', detail: `模型存在（HTTP ${status}${message.length > 0 ? ` ${message}` : ''}）` }
  }
  const message = /"msg":"([^"]{0,60})/.exec(text)?.[1] ?? ''
  return { state: 'error', detail: `HTTP ${status}${message.length > 0 ? ` ${message}` : ''}` }
}

/**
 * The probe body, per deployment. Both shapes were measured on 2026-10-21:
 *
 * | | China | International |
 * | --- | --- | --- |
 * | validation order | model first, then parameters | conversation shape first (`11128 first message is not system`) |
 * | body | `{"model":M,"messages":[],"stream":true}` | `{"model":M,"messages":[{system:""}],"stream":true,"max_tokens":1}` |
 * | verdicts | `11133`/`11151` live · `11102` gone | `200` usable · `11158` no permission · `11102` gone |
 *
 * Neither generates, and neither bills: measured with eight probes each, the
 * credit balance did not move on either deployment (China `glm-5.3`, 0.69x;
 * international `kimi-k3`, 1.62x). The international shape works because an
 * *empty* system message satisfies "the first message must be system" and then
 * fails content validation (`11151`), so the request is refused before dispatch —
 * the role's own template tokens would only be billed if it were sent.
 * Shapes tried as a way to make a well-formed request invalid —
 * `reasoning_effort: "测试"`, `thinking: {type:"测试"}`, orphan `tool_calls`,
 * `max_tokens: 0/-1`, a wrong-typed `stop` — were all either ignored by both
 * gateways or refused before the model was resolved, so none would have produced
 * a verdict.
 */
export function probeBody(region, id) {
  // Free on China: the gateway resolves the model before validating the
  // conversation, so an empty array is answered at the parameter layer.
  if (region.freeProbe === true) return { model: id, messages: [], stream: true }
  // The international gateway insists the first message is `system`, then does
  // its model and entitlement checks. An empty system message satisfies that
  // check with the smallest possible prompt, and the answer comes back as
  // 200 / 11158 / 11102 without streaming a single token (observed over six
  // seconds; the first two shapes below were also measured with the same result:
  // `[{system:''},{user:''}]` and a missing `content` key).
  return { model: id, messages: [{ role: 'system', content: '' }], stream: true, max_tokens: 1 }
}

/**
 * Ask one model whether it is usable, with the cheapest shape that deployment
 * answers (see {@link probeBody}).
 *
 * @returns {Promise<{ id: string, state: string, detail: string, at: number, ms: number }>}
 */
export async function probeModel(ctx, region, id, options = {}) {
  const started = Date.now()
  const token = options.token ?? await readToken(ctx, region)
  const [route] = chatRoutes(region)
  const record = (state, detail) => ({ id, state, detail, at: Date.now(), ms: Date.now() - started })
  if (token.length === 0) return record('auth', '未登录')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-Domain': route.apiDomain,
        'X-Product': 'SaaS',
        'X-Product-Code': route.productCode,
        'X-Agent-Purpose': 'conversation',
        'X-IDE-Name': route.ideName,
        'X-IDE-Type': route.ideName,
        'X-IDE-Version': route.ideVersion,
        'User-Agent': route.userAgent,
        'X-Conversation-ID': crypto.randomUUID().replace(/-/g, ''),
        'X-Conversation-Message-ID': crypto.randomUUID(),
        'X-Conversation-Request-ID': crypto.randomUUID()
      },
      body: JSON.stringify(probeBody(region, id)),
      signal: controller.signal
    })
    if (response.status === 200) {
      // Some deployments may accept the shape; a 200 is a valid model either way.
      await response.body?.cancel().catch(() => {})
      return record('ok', '')
    }
    const body = await response.text().catch(() => '')
    const verdict = classifyProbe(response.status, body)
    return record(verdict.state, verdict.detail)
  } catch (error) {
    return record('error', String(error?.message ?? error).slice(0, 80))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How often a deployment may sweep itself, and whether a probe there is free.
 *
 * China answers an invalid request without generating, so it can be checked
 * often — the panel refreshes it every time it is opened. The international
 * gateway needs a well-formed request, which starts a one-token completion, so
 * there it is once a day at most and the panel's button is the way to ask for
 * more.
 */
export const SWEEP_MIN_INTERVAL_MS = 24 * 3600_000

/** Whether a sweep may run now; `manual` callers skip this check. */
export function sweepDue(regionId, minIntervalMs = SWEEP_MIN_INTERVAL_MS, now = Date.now()) {
  const last = readAvailability(regionId).lastSweepAt
  return { due: now - last >= minIntervalMs, lastSweepAt: last }
}

/** Probe a list of ids, a few at a time, and persist every verdict. */
export async function runSweep(ctx, region, ids, options = {}) {
  const interval = options.minIntervalMs ?? SWEEP_MIN_INTERVAL_MS
  if (options.manual !== true) {
    const due = sweepDue(region.id, interval)
    if (due.due !== true) return { skipped: true, reason: 'interval', lastSweepAt: due.lastSweepAt, results: [] }
  }
  const token = await readToken(ctx, region)
  const results = []
  let cursor = 0
  const concurrency = Math.max(1, options.concurrency ?? PROBE_CONCURRENCY)
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor]
      cursor += 1
      const result = await probeModel(ctx, region, id, { token })
      results.push(result)
      options.onResult?.(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
  if (results.length > 0) writeAvailability(region.id, results)
  markSwept(region.id)
  return { skipped: false, results }
}

/** @returns {{ savedAt: number, lastSweepAt: number, models: Map<string, {state: string, detail: string, at: number}> }} */
export function readAvailability(regionId) {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(regionId), 'utf8'))
    if (parsed?.version !== LEDGER_VERSION || typeof parsed.models !== 'object' || parsed.models === null) {
      return { savedAt: 0, lastSweepAt: 0, models: new Map() }
    }
    return {
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      lastSweepAt: typeof parsed.lastSweepAt === 'number' ? parsed.lastSweepAt : 0,
      models: new Map(Object.entries(parsed.models))
    }
  } catch {
    return { savedAt: 0, lastSweepAt: 0, models: new Map() }
  }
}

function store(regionId, ledger, now) {
  mkdirSync(ledgerDir(), { recursive: true })
  writeFileSync(ledgerPath(regionId), JSON.stringify({
    version: LEDGER_VERSION,
    savedAt: now,
    lastSweepAt: ledger.lastSweepAt,
    models: Object.fromEntries(ledger.models)
  }))
}

/** Merge verdicts by id (a fresh verdict always wins) and store them. */
export function writeAvailability(regionId, results) {
  try {
    const ledger = readAvailability(regionId)
    const now = Date.now()
    for (const result of results) {
      if (typeof result?.id !== 'string' || result.id.length === 0) continue
      ledger.models.set(result.id, {
        state: String(result.state ?? 'error'),
        detail: String(result.detail ?? ''),
        at: typeof result.at === 'number' ? result.at : now,
        ...(typeof result.ms === 'number' ? { ms: result.ms } : {})
      })
    }
    store(regionId, ledger, now)
    return true
  } catch {
    return false
  }
}

/** Record that a full sweep just ran, which is what the daily limit reads. */
function markSwept(regionId) {
  try {
    const ledger = readAvailability(regionId)
    ledger.lastSweepAt = Date.now()
    store(regionId, ledger, Date.now())
    return true
  } catch {
    return false
  }
}

/** Ids the ledger considers unusable, within the verdict's TTL. */
export function unusableModelIds(regionId, now = Date.now()) {
  const unusable = new Set()
  for (const [id, entry] of readAvailability(regionId).models) {
    if (!UNUSABLE_STATES.has(entry?.state)) continue
    if (typeof entry.at !== 'number' || now - entry.at > AVAILABILITY_TTL_MS) continue
    unusable.add(id)
  }
  return unusable
}

/** Kept for callers that only care about delisted models. */
export function deadModelIds(regionId, now = Date.now()) {
  const dead = new Set()
  for (const [id, entry] of readAvailability(regionId).models) {
    if (entry?.state !== 'dead') continue
    if (typeof entry.at !== 'number' || now - entry.at > AVAILABILITY_TTL_MS) continue
    dead.add(id)
  }
  return dead
}

/** One-line summary for the panel and the command. */
export function availabilitySummary(regionId) {
  const ledger = readAvailability(regionId)
  const counts = new Map()
  for (const entry of ledger.models.values()) {
    const state = String(entry?.state ?? 'error')
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  return {
    savedAt: ledger.savedAt,
    total: ledger.models.size,
    counts: Object.fromEntries(counts),
    models: [...ledger.models.entries()].map(([id, entry]) => ({ id, ...entry }))
  }
}
