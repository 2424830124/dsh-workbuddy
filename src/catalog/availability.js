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
 * Verdicts live in `$DSH_HOME/dsh-workbuddy/availability-<region>[-<account>].json`
 * keyed by model id *per account*, and a verdict decides grouping and suspension until it
 * ages out (`AVAILABILITY_TTL_MS`).
 *
 * The verdict is also learned for free: when a real chat turn fails with
 * `11102`, the adapter records it here, so a model that dies mid-session stops
 * being advertised without waiting for a sweep.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { accountOf, accountUidOf, freshToken, usableSlot } from '../account/auth.js'
import { PRIMARY_ACCOUNT, listAccounts } from '../account/pool.js'
import { chatRoutes } from '../core/regions.js'
import { ensurePluginDir } from '../core/paths.js'
import { readPrefs, setAutoOff } from './model-prefs.js'

const LEDGER_VERSION = 1
/** How long a probe verdict is trusted before the model is swept again. */
export const AVAILABILITY_TTL_MS = 12 * 3600_000
const PROBE_CONCURRENCY = 3
const PROBE_TIMEOUT_MS = 30_000

/**
 * Verdicts that make the sweep **suspend** a model the user had switched on.
 *
 * Deliberately narrower than the panel's 不可用 grouping. `auth`, `noquota` and `throttled`
 * are answers about the *account*, not about the model — one exhausted balance would
 * otherwise suspend every model of the pool at once, and lifting that would need a sweep to
 * say so. The panel still files those rows under 不可用 (see `UNUSABLE_STATES` in
 * `client/index.js`); the two lists answer different questions and are meant to differ.
 */
const SUSPENDING_STATES = new Set(['dead', 'denied'])

function ledgerDir() {
  return ensurePluginDir()
}

/**
 * Ledgers, one file per (deployment, account): a pool of accounts each has its own.
 *
 * The key is the *pool* account id — the same string the panel and the adapter use — not
 * the upstream uid. Keying by uid here and by pool id there is what made every verdict
 * invisible: the sweeps wrote files nobody read, so every dot stayed grey.
 *
 * The primary account deliberately keeps the un-suffixed file name, which is what every
 * install wrote before accounts could be added.
 */
function ledgerPath(regionId, account) {
  const id = typeof account === 'string' ? account : ''
  const suffix = id.length === 0 || id === PRIMARY_ACCOUNT ? '' : `-${id.replace(/[^A-Za-z0-9_-]/g, '')}`
  return join(ledgerDir(), `availability-${regionId}${suffix}.json`)
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
  // `429` is four different answers and only two of them say the model can be used later
  // today by this account:
  //
  //  - queue (`6020`) — the model is busy; the next attempt may well succeed, so it stays
  //    in the usable group. Handled above, before this branch.
  //  - plain "model busy" wording (`模型繁忙，请换模型或稍后重试 too many requests`) — busy
  //    without a queue, and equally transient. Handled in the 429 branch below.
  //  - credits exhausted (`14018`) — nothing works until someone pays.
  //  - rate window used up (`6004` / `exceeds frequency limit`) — nothing works until the
  //    stated reset, which is hours away.
  //
  // The last two are verdicts, not guesses: the account cannot call them now. A bare `429`
  // with none of those wordings stays `error` — unknown, retryable — because claiming a
  // rate window the body never stated would be exactly the misread reported on 2026-10-25.
  if (status === 429) {
    if (/14018|credits exhausted|insufficient_quota/i.test(text)) {
      return { state: 'noquota', detail: '积分已用尽（HTTP 429 code 14018）' }
    }
    if (/模型繁忙|模型正忙|model (?:is )?(?:currently )?busy/i.test(text)) {
      return { state: 'busy', detail: '模型繁忙（稍后重试）' }
    }
    if (/6004|exceeds frequency limit|usage exceeds|超出频率限制|频率限制|reset at/i.test(text)) {
      return { state: 'throttled', detail: `频率超限（HTTP 429${/6004/.test(text) ? ' code 6004' : ''}）` }
    }
  }
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
  const token = options.token ?? await freshToken(ctx, usableSlot(region))
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
export function sweepDue(regionId, minIntervalMs = SWEEP_MIN_INTERVAL_MS, now = Date.now(), account) {
  const last = readAvailability(regionId, account).lastSweepAt
  return { due: now - last >= minIntervalMs, lastSweepAt: last }
}

/** Probe a list of ids, a few at a time, and persist every verdict. */
export async function runSweep(ctx, region, ids, options = {}) {
  const interval = options.minIntervalMs ?? SWEEP_MIN_INTERVAL_MS
  // Verdicts describe one account's entitlements, so the sweep is scoped to whoever is
  // logged in now: a new account starts from an empty ledger and gets its own probes.
  const account = accountOf(usableSlot(region))
  const uid = await accountUidOf(ctx, usableSlot(region))
  if (options.manual !== true) {
    const due = sweepDue(region.id, interval, Date.now(), account)
    if (due.due !== true) return { skipped: true, reason: 'interval', lastSweepAt: due.lastSweepAt, results: [] }
  }
  // One fresh token for the whole sweep: the probes are metadata-only calls, so a token
  // minted two minutes ago is guaranteed to be good for all of them.
  const token = await freshToken(ctx, usableSlot(region))
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
  if (results.length > 0) writeAvailability(region.id, results, account, uid)
  markSwept(region.id, account, uid)
  // The sweep is the only thing that learns verdicts in bulk, so it is also where the
  // offered set follows them — the panel and the picker then read one consistent answer.
  const autoOff = syncAutoOff(region.id, listAccounts(region).map((entry) => entry.id))
  return { skipped: false, results, account, autoOff }
}

/** @returns {{ savedAt: number, lastSweepAt: number, models: Map<string, {state: string, detail: string, at: number}> }} */
/** Read the ledger as stored (no account filtering). */
function readLedger(regionId, account) {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(regionId, account), 'utf8'))
    if (parsed?.version !== LEDGER_VERSION || typeof parsed.models !== 'object' || parsed.models === null) {
      return { account: undefined, savedAt: 0, lastSweepAt: 0, models: new Map() }
    }
    return {
      account: typeof parsed.account === 'string' && parsed.account.length > 0 ? parsed.account : undefined,
      uid: typeof parsed.uid === 'string' && parsed.uid.length > 0 ? parsed.uid : undefined,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      lastSweepAt: typeof parsed.lastSweepAt === 'number' ? parsed.lastSweepAt : 0,
      models: new Map(Object.entries(parsed.models))
    }
  } catch {
    return { account: undefined, uid: undefined, savedAt: 0, lastSweepAt: 0, models: new Map() }
  }
}

/**
 * @param regionId deployment id
 * @param account which account's ledger to read; it is its own file
 * @returns {{ savedAt: number, lastSweepAt: number, models: Map<string, {state: string, detail: string, at: number}> }}
 */
export function readAvailability(regionId, account) {
  const ledger = readLedger(regionId, account)
  return { savedAt: ledger.savedAt, lastSweepAt: ledger.lastSweepAt, models: ledger.models }
}

function store(regionId, ledger, now, account) {
  mkdirSync(ledgerDir(), { recursive: true })
  writeFileSync(ledgerPath(regionId, account), JSON.stringify({
    version: LEDGER_VERSION,
    ...(ledger.account === undefined ? {} : { account: ledger.account }),
    // The upstream uid, when the account has one. Informational: it makes a file on disk
    // traceable to a person, and it is deliberately *not* the key — see `ledgerPath`.
    ...(ledger.uid === undefined ? {} : { uid: ledger.uid }),
    savedAt: now,
    lastSweepAt: ledger.lastSweepAt,
    models: Object.fromEntries(ledger.models)
  }))
}

/**
 * Merge verdicts by id (a fresh verdict always wins) and store them.
 *
 * One file per account now, so a second signed-in account neither inherits the first
 * one's `denied` marks nor erases them: the two verdict sets never share a document.
 * The `account` field stays inside the file because the file name only carries a
 * sanitised form of it.
 */
export function writeAvailability(regionId, results, account, uid) {
  try {
    const ledger = readLedger(regionId, account)
    const now = Date.now()
    if (account !== undefined) ledger.account = account
    if (uid !== undefined) ledger.uid = uid
    for (const result of results) {
      if (typeof result?.id !== 'string' || result.id.length === 0) continue
      ledger.models.set(result.id, {
        state: String(result.state ?? 'error'),
        detail: String(result.detail ?? ''),
        at: typeof result.at === 'number' ? result.at : now,
        ...(typeof result.ms === 'number' ? { ms: result.ms } : {})
      })
    }
    store(regionId, ledger, now, account)
    return true
  } catch {
    return false
  }
}

/** Record that a full sweep just ran, which is what the daily limit reads. */
function markSwept(regionId, account, uid) {
  try {
    const ledger = readLedger(regionId, account)
    if (uid !== undefined) ledger.uid = uid
    ledger.lastSweepAt = Date.now()
    store(regionId, ledger, Date.now(), account)
    return true
  } catch {
    return false
  }
}

/** One-line summary for the panel and the command. */
export function availabilitySummary(regionId, account) {
  const ledger = readAvailability(regionId, account)
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

/**
 * What the panel shows for a deployment that may hold several accounts.
 *
 * A model is listed as usable when *any* account can call it, which is the question a
 * person looking at the list is asking. The worst verdict wins only when every account
 * refused, and a verdict from one account never hides a model another can use — with two
 * accounts, "one is out of credits" says nothing about whether the model is callable.
 *
 * Reads at most one ledger per account, and an account with no verdict at all counts as
 * "no opinion" rather than as a refusal.
 */
export function aggregateAvailability(regionId, accounts) {
  const ids = Array.isArray(accounts) && accounts.length > 0 ? accounts : [undefined]
  const perAccount = ids.map((account) => readAvailability(regionId, account))
  const merged = new Map()
  for (const ledger of perAccount) {
    for (const [id, entry] of ledger.models) {
      const previous = merged.get(id)
      const state = String(entry?.state ?? 'error')
      if (previous === undefined) {
        merged.set(id, { ...entry, state, accounts: [state] })
        continue
      }
      previous.accounts.push(state)
      // A usable verdict from one account wins outright.
      if (previous.state !== 'ok' && state === 'ok') {
        merged.set(id, { ...entry, state: 'ok', accounts: previous.accounts })
      } else if (isFatal(previous.state) && !isFatal(state)) {
        // An undecided state says less than "no permission": keep the more specific one.
        merged.set(id, { ...entry, state, accounts: previous.accounts })
      }
    }
  }
  const counts = new Map()
  for (const entry of merged.values()) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1)
  return {
    savedAt: perAccount.reduce((latest, ledger) => Math.max(latest, ledger.savedAt ?? 0), 0),
    total: merged.size,
    counts: Object.fromEntries(counts),
    models: merged,
    multiple: ids.length > 1
  }
}

/** Verdicts that would hide a model from every account. */
const FATAL_STATES = new Set(['dead', 'denied', 'blocked'])
const isFatal = (state) => FATAL_STATES.has(state)

/**
 * Make the offered set follow the verdicts.
 *
 * A model that stops answering should leave the picker, but the user's switch is not the
 * place to record that: deleting it would lose the choice, and the model would come back as
 * "off" the day it is usable again. So a suspension is written *next to* the choice
 * (`autoOff`), and lifting it puts the switch back exactly where it was.
 *
 * The decision comes from the aggregate verdict, not from one ledger: an account of the pool
 * saying `denied` must not suspend a model a sibling can still call, and the same rule keeps
 * a suspension from being lifted by an account that merely has not been probed yet.
 */
export function syncAutoOff(regionId, accountIds, now = Date.now()) {
  const merged = aggregateAvailability(regionId, accountIds).models
  const unusable = new Set()
  for (const [id, entry] of merged) {
    if (!SUSPENDING_STATES.has(entry?.state)) continue
    if (typeof entry.at !== 'number' || now - entry.at > AVAILABILITY_TTL_MS) continue
    unusable.add(id)
  }
  const prefs = readPrefs(regionId)
  return setAutoOff(regionId, {
    suspend: [...prefs.enabled].filter((id) => unusable.has(id)),
    resume: [...prefs.autoOff].filter((id) => !unusable.has(id))
  })
}
