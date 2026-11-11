/**
 * WorkBuddy's plugin login protocol and the credentials it produces.
 *
 *   POST /v2/plugin/auth/state?platform=…   → { state, authUrl }
 *   GET  /v2/plugin/auth/token?state=…      → { accessToken, refreshToken, … }
 *   GET  /v2/plugin/login/account?state=…   → { uid, nickname, enterpriseId, … }
 *   POST /v2/plugin/auth/token/refresh      → rotated tokens
 *
 * Tokens live in the deployment's account pool (see `pool.js`): account #1 is
 * stored under the region's own `tokenRef`/`metaRef`, so an install from before
 * the pool existed keeps working, and every account added later under
 * `tokenRef#<id>` / `metaRef#<id>`. The access token is the bare bearer value;
 * everything that rotates around it — refresh token, expiry, account identity,
 * last check-in outcome — is JSON under that account's meta ref.
 */

import {
  STATE_TIMEOUT_MS,
  formatWhen,
  readString,
  requestJson,
  responseCode,
  responseData,
  responseMessage,
  sleep,
  tokenExpiryMs,
  tokenNickname
} from '../core/http.js'
import { readCredential as readRef, resolveCredential, setCredential, unsetCredential } from '../core/paths.js'
import { PRIMARY_ACCOUNT, listAccounts, newAccountId, registerAccount, removeAccount, slotFor } from './pool.js'
import { clearLoggedOut, markLoggedOut, readPrefs } from '../catalog/model-prefs.js'
import { REGION_IDS, REGIONS, openInBrowser } from '../core/regions.js'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 1_500
/** Rotate once the access token is inside this window of expiring. */
const REFRESH_SKEW_MS = 24 * 3600_000
/** A login session stays open long enough for the user to finish in their browser. */
const STARTED_LOGIN_TTL_MS = LOGIN_TIMEOUT_MS + 60_000

/**
 * A storage key for one account of one deployment.
 *
 * The primary account keeps the bare deployment id, which is what `pendingLogins` and
 * generation maps held before accounts could be added — so nothing that watched "is
 * cn signed in" has to learn about accounts it never had.
 */
export function slotKey(slot) {
  const account = slot?.account
  return account === undefined || account === PRIMARY_ACCOUNT ? String(slot.id) : `${slot.id}:${account}`
}

/** Which account of its deployment a slot points at; the primary one by default. */
export function accountOf(slot) {
  const account = slot?.account
  return account === undefined || account === null ? PRIMARY_ACCOUNT : String(account)
}

const isPrimary = (slot) => accountOf(slot) === PRIMARY_ACCOUNT

/**
 * Background sweep cadence.
 *
 * Not "tokens live for weeks": the mainland access token stops being accepted after about
 * 21 minutes even though its `exp` claim is 28 days out (measured 2026-10-23 — 401s at
 * 16:22, 16:43 and 17:04, each fixed by one forced refresh). The claim is an upper bound and
 * the server retires the session well before it, so a 6-hour sweep left every request in
 * between failing with 401 — which is what "the account keeps expiring" was.
 *
 * Below the observed lifetime with margin, so a fresh token is normally in hand before the
 * old one stops working.
 */
export const REFRESH_INTERVAL_MS = 10 * 60_000
export const REFRESH_BOOT_DELAY_MS = 8_000

const AUTH_STATE_PATH = '/v2/plugin/auth/state'
const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
/** "Token not ready yet" while the user is still on the authorization page. */
const CODE_TOKEN_NOT_READY = 11217

/**
 * One in-flight login per account slot, so a repeated command reports instead of
 * forking a second flow.
 */
export const pendingLogins = new Map()

/** Drop a pending login whose poll died without clearing its own entry. */
function prunePending(key) {
  const entry = pendingLogins.get(key)
  if (entry === undefined) return undefined
  if (Date.now() - entry.startedAt <= STARTED_LOGIN_TTL_MS) return entry
  pendingLogins.delete(key)
  return undefined
}

/** Whether any account of this deployment is waiting for a browser step. */
export function pendingAccounts(region) {
  for (const key of pendingLogins.keys()) {
    if (key !== region.id && !key.startsWith(`${region.id}:`)) continue
    if (prunePending(key) !== undefined) return true
  }
  return false
}

/**
 * The login flow a panel should be showing for this deployment, if any.
 *
 * The panel needs this from the host, because a pending login is a fact about the host: the
 * authorization URL was minted here and the poll that will finish it runs here. The panel used
 * to keep that URL only in its own memory, so reloading the settings page — or any client
 * hot-reload — left a 等待授权… state on screen with no link and no way to cancel it.
 */
export function pendingLoginFor(region) {
  const prefix = `${region.id}:`
  for (const key of pendingLogins.keys()) {
    if (key !== region.id && !key.startsWith(prefix)) continue
    const entry = prunePending(key)
    if (entry === undefined) continue
    return {
      key,
      account: key === region.id ? PRIMARY_ACCOUNT : key.slice(prefix.length),
      url: entry.url,
      startedAt: entry.startedAt
    }
  }
  return undefined
}

/**
 * Abandon every in-flight login of a deployment, or the one account named.
 *
 * Bumping the generation is the part that matters: the poll for that flow is still running and
 * would otherwise store the token it is waiting for, turning a cancelled login into an account
 * the user never finished adding. The generation check in `beginLogin` is what makes that
 * impossible, so cancelling must go through it rather than only deleting the map entry.
 */
export function cancelLogin(region, account) {
  const prefix = `${region.id}:`
  const wanted = account === undefined ? undefined : slotFor(region, account)
  let cancelled = 0
  for (const key of [...pendingLogins.keys()]) {
    if (key !== region.id && !key.startsWith(prefix)) continue
    if (wanted !== undefined && key !== slotKey(wanted)) continue
    // Drops the map entry as well as invalidating the poll that is waiting on it.
    bumpAuthGeneration(key === region.id ? region : slotFor(region, key.slice(prefix.length)))
    cancelled += 1
  }
  return { cancelled }
}
/**
 * Account generations, one per account slot.
 *
 * Every asynchronous path that later writes credentials or a catalog compares the
 * generation it started under with the current one. Logging out or switching accounts
 * bumps it, so a slow refresh, a background login poll, or a delayed catalog response
 * that started before the switch can no longer resurrect the previous account.
 */
const generations = new Map()

export function authGeneration(region) {
  return generations.get(slotKey(region)) ?? 0
}

/** Invalidate in-flight work for this account and drop its pending login. */
export function bumpAuthGeneration(region) {
  const key = slotKey(region)
  generations.set(key, authGeneration(region) + 1)
  pendingLogins.delete(key)
  return generations.get(key)
}

/**
 * Log out: invalidate in-flight work first, then delete the stored credentials.
 *
 * The order matters — a refresh that returns after the deletion would otherwise write
 * the old account straight back, which is exactly the bug this replaces.
 *
 * Signing out one account leaves its siblings alone. Only when the last one goes does the
 * deployment look signed out to the picker, which is why `markLoggedOut` is conditional.
 */
export async function logoutRegion(ctx, region) {
  bumpAuthGeneration(region)
  // Both lookups below need the credentials that are about to be deleted: `remaining` asks
  // who is still signed in, and `removeAccount` reads this account's metadata to recognise
  // the other ids the same person was signed in under. Unsetting first left the pool entry
  // behind with nothing pointing at it, and the panel drew it as a 未知 / 未登录 row.
  const remaining = listAccounts(region).filter((entry) => entry.id !== accountOf(region) && entry.loggedIn)
  // Removes this account from the pool *and* deletes its credentials, including those of
  // every id carrying the same identity — that is what stops the row from coming back.
  removeAccount(region, accountOf(region))
  // Belt and braces: covers an account that was never written to the pool file.
  unsetCredential(region.tokenRef)
  unsetCredential(region.metaRef)
  // Hiding the models is part of logging out: the picker kept offering them because the
  // cached catalog was still there, so a logged-out deployment looked callable. The enabled
  // set is deliberately left alone — it records what the user chose, not what the credentials
  // currently allow — and the marker is cleared by `clearLoggedOut` on the next login.
  if (remaining.length === 0) markLoggedOut(region.id)
  ctx.logger.info(`[workbuddy] ${slotKey(region)}: 已退出登录，凭据已删除${remaining.length === 0 ? '，模型已从选择器移除' : `（该部署还有 ${remaining.length} 个账号可用）`}`)
}

/**
 * The stored model preferences, with the logged-out marker reconciled against the credentials.
 *
 * The marker exists so a signed-out deployment advertises nothing, and it is a *cache* of a
 * fact that lives on disk as a token. A cache can be wrong: one logout that misjudged which
 * accounts remained left the marker set while a valid token was still stored, and from then
 * on every model of that deployment read as switched off — indistinguishable, in the panel,
 * from the user's own choices being thrown away. So the credentials decide, and a marker that
 * contradicts them is cleared and reported as logged in.
 */
export function prefsFor(region) {
  const prefs = readPrefs(region.id)
  if (prefs.loggedOut !== true) return prefs
  if (!listAccounts(region).some((entry) => entry.loggedIn)) return prefs
  clearLoggedOut(region.id)
  return { ...prefs, loggedOut: false }
}

function authHeaders(region, extra = {}) {
  return { 'X-Domain': region.apiDomain, 'User-Agent': region.userAgent, ...extra }
}

async function fetchAuthState(region) {
  const url = `${region.endpoint}${AUTH_STATE_PATH}?platform=${encodeURIComponent(region.platform)}`
  const headers = authHeaders(region, {
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true'
  })
  const { status, json } = await requestJson('POST', url, headers, { timeoutMs: STATE_TIMEOUT_MS })
  if (status !== 200) throw new Error(`auth/state HTTP ${status}${responseMessage(json) ? `: ${responseMessage(json)}` : ''}`)
  const data = responseData(json)
  const state = readString(data, 'state')
  const authUrl = readString(data, 'authUrl')
  if (state.length === 0) throw new Error('auth/state 响应缺少 state')
  if (authUrl.length === 0) throw new Error('auth/state 响应缺少 authUrl')
  return { state, authUrl }
}

/** The login URL carries the plugin version and a unique session id, like the official clients. */
function decorateAuthUrl(authUrl, region) {
  try {
    const url = new URL(authUrl)
    url.searchParams.set('version', region.version)
    url.searchParams.set('loginSessionId', crypto.randomUUID())
    return url.toString()
  } catch {
    return authUrl
  }
}

/** Poll until the user finishes the browser step; `11217` means "not ready yet". */
async function pollAuthToken(region, state) {
  const url = `${region.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const headers = authHeaders(region, { 'X-No-Authorization': 'true' })
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('登录超时（5 分钟）')
    await sleep(POLL_INTERVAL_MS)
    const { status, json } = await requestJson('GET', url, headers)
    if (status === 200) {
      const data = responseData(json)
      if (data === undefined) continue
      const accessToken = readString(data, 'accessToken')
      if (accessToken.length === 0) continue
      return {
        accessToken,
        refreshToken: readString(data, 'refreshToken'),
        expiresIn: typeof data.expiresIn === 'number' ? data.expiresIn : 0,
        refreshExpiresIn: typeof data.refreshExpiresIn === 'number' ? data.refreshExpiresIn : 0,
        domain: readString(data, 'domain')
      }
    }
    if (responseCode(json) === CODE_TOKEN_NOT_READY) continue
    throw new Error(`auth/token HTTP ${status}${responseMessage(json) ? `: ${responseMessage(json)}` : ''}`)
  }
}

async function fetchAccount(region, token, state) {
  const url = `${region.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
  const headers = authHeaders(region, {
    'X-Domain': token.domain.length > 0 ? token.domain : region.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true'
  })
  const { status, json } = await requestJson('GET', url, headers)
  if (status !== 200) return { uid: '', nickname: '', enterpriseId: '', accountType: '' }
  const data = responseData(json) ?? {}
  return {
    uid: readString(data, 'uid'),
    nickname: readString(data, 'nickname'),
    enterpriseId: readString(data, 'enterpriseId'),
    accountType: readString(data, 'type')
  }
}

export async function readMeta(ctx, region) {
  try {
    const resolved = resolveCredential(region.metaRef)
    if (resolved === undefined || resolved.value.length === 0) return undefined
    const parsed = JSON.parse(resolved.value)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function readToken(ctx, region) {
  try {
    const resolved = resolveCredential(region.tokenRef)
    return resolved === undefined || resolved.value.length === 0 ? '' : resolved.value
  } catch {
    return ''
  }
}

/**
 * How old a token may be before a request refreshes it first.
 *
 * The claim says 28 days and the server disagrees — the host log has a refreshed token
 * rejected 90 seconds later — so "is it still valid according to the JWT" is not a usable
 * question. Two minutes keeps every outgoing request holding a token that was just minted,
 * at the cost of at most one refresh per two minutes per region.
 */
export const TOKEN_MAX_AGE_MS = 2 * 60_000

/**
 * The token to send, refreshed first when it is older than {@link TOKEN_MAX_AGE_MS}.
 *
 * This is the "refresh before you send" the official clients do implicitly: it makes every
 * caller — chat, catalog, credits, busy — start from a fresh token instead of discovering a
 * dead one through a 401. A failed refresh is not fatal: the caller still gets the token it
 * had, and its own 401 path takes over.
 */
export async function freshToken(ctx, region) {
  const slot = usableSlot(region)
  const meta = await readMeta(ctx, slot)
  const age = typeof meta?.updatedAt === 'number' ? Date.now() - meta.updatedAt : Number.POSITIVE_INFINITY
  if (age > TOKEN_MAX_AGE_MS) {
    await refreshRegion(ctx, slot, { rotate: true }).catch(() => undefined)
  }
  return readToken(ctx, slot)
}

/**
 * The account a read should use when the caller did not name one.
 *
 * Catalog, credits, busy and the availability sweep are deployment-wide reads, not
 * turn-by-turn ones: any signed-in account answers them, and the answer is the same
 * shape. A bare `region` therefore resolves to the primary account, and — when that one
 * was signed out — to the first account of the pool that still holds a token, so adding
 * an account keeps those reads working instead of leaving the deployment half dead.
 *
 * A slot that already names an account is returned untouched: those call sites are
 * asking about that account specifically.
 */
export function usableSlot(region) {
  if (region?.tokenRef !== undefined && region?.account !== undefined) return region
  const primary = slotFor(region, PRIMARY_ACCOUNT)
  if (readRef(primary.tokenRef).length > 0) return primary
  for (const entry of listAccounts(region)) {
    const slot = slotFor(region, entry.id)
    if (readRef(slot.tokenRef).length > 0) return slot
  }
  return primary
}

/**
 * One refresh in flight per region.
 *
 * The sweep, a 401 retry, the panel's 续期 button and a chat request can all decide to
 * refresh within the same second — the host log shows four refreshes inside four seconds.
 * They all read the same refresh token and race to write a new one, so whichever finishes
 * last decides what is stored. Sharing the promise means one request, one write.
 */
const refreshInFlight = new Map()

/**
 * Rotate one region's tokens when the access token is close to expiry.
 * Failures are logged, never thrown: a stale token must not break the plugin.
 */
export async function refreshRegion(ctx, region, options = {}) {
  const key = slotKey(region)
  const running = refreshInFlight.get(key)
  if (running !== undefined) return running
  const task = performRefresh(ctx, region, options).finally(() => refreshInFlight.delete(key))
  refreshInFlight.set(key, task)
  return task
}

async function performRefresh(ctx, region, options) {
  const generation = authGeneration(region)
  const meta = await readMeta(ctx, region)
  if (meta === undefined || typeof meta.refreshToken !== 'string' || meta.refreshToken.length === 0) {
    return { refreshed: false, reason: '未登录' }
  }
  const expiresAt = typeof meta.expiresAt === 'number' ? meta.expiresAt : 0
  // `options.rotate` is what the background sweep passes: it refreshes on its own cadence
  // and must not consult `expiresAt`, because that value comes from the token's `exp` claim
  // and the mainland deployment retires the session long before the claim (see
  // REFRESH_INTERVAL_MS). The claim is still useful for the *lazy* case — a caller that just
  // wants "make sure this is fresh" and would otherwise skip a pointless round trip.
  const lazy = options.force !== true && options.rotate !== true
  if (lazy && expiresAt > 0 && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return { refreshed: false, reason: '仍然有效' }
  }
  const accessToken = await readToken(ctx, region)
  if (accessToken.length === 0) return { refreshed: false, reason: '缺少访问令牌' }

  const headers = authHeaders(region, {
    Authorization: `Bearer ${accessToken}`,
    'X-Refresh-Token': meta.refreshToken,
    'X-Auth-Refresh-Source': 'ide-main'
  })
  const { status, json } = await requestJson('POST', `${region.endpoint}${AUTH_REFRESH_PATH}`, headers)
  if (status !== 200) {
    const message = responseMessage(json)
    ctx.logger.warn(`[workbuddy] ${region.id}: 续期失败 HTTP ${status}${message.length > 0 ? `: ${message}` : ''}，请运行 /workbuddy login ${region.id}`)
    return { refreshed: false, reason: `HTTP ${status}` }
  }
  const data = responseData(json) ?? {}
  const nextAccess = readString(data, 'accessToken')
  if (nextAccess.length === 0) return { refreshed: false, reason: '续期响应为空' }
  // Logging out or switching accounts while the refresh was in flight invalidates this
  // result: writing it would put the old account back.
  if (authGeneration(region) !== generation) {
    ctx.logger.info(`[workbuddy] ${region.id}: 续期结果已过期（期间退出或切换账号），不写回`)
    return { refreshed: false, reason: '账号已切换' }
  }

  const now = Date.now()
  const nextRefresh = readString(data, 'refreshToken')
  const expiresIn = typeof data.expiresIn === 'number' ? data.expiresIn : 0
  const refreshExpiresIn = typeof data.refreshExpiresIn === 'number' ? data.refreshExpiresIn : 0
  setCredential(region.tokenRef, nextAccess)
  setCredential(region.metaRef, JSON.stringify({
    ...meta,
    refreshToken: nextRefresh.length > 0 ? nextRefresh : meta.refreshToken,
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : tokenExpiryMs(nextAccess) ?? 0,
    refreshExpiresAt: refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : meta.refreshExpiresAt ?? 0,
    updatedAt: now
  }))
  // The pool's copy is what the panel shows; it must not lag behind a renewal.
  if (isPrimary(region)) registerAccount(region, { id: PRIMARY_ACCOUNT, nickname: typeof meta.nickname === 'string' ? meta.nickname : '', uid: typeof meta.uid === 'string' ? meta.uid : '', expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : (tokenExpiryMs(nextAccess) ?? 0) })
  ctx.logger.info(`[workbuddy] ${slotKey(region)}: 访问令牌已续期`)
  return { refreshed: true }
}

/**
 * Write one account's credentials and remember it in the deployment's pool.
 *
 * The account id is decided before the write so the refs are right: an id that is
 * already signed in is refreshed in place, a new one is appended to the end of the
 * order — which is also the fallback order requests use.
 */
function storeCredential(ctx, region, token, account) {
  const now = Date.now()
  const expiresAt = token.expiresIn > 0 ? now + token.expiresIn * 1000 : tokenExpiryMs(token.accessToken) ?? 0
  const refreshExpiresAt = token.refreshExpiresIn > 0 ? now + token.refreshExpiresIn * 1000 : 0
  const nickname = account.nickname.length > 0 ? account.nickname : tokenNickname(token.accessToken)
  const id = accountOf(region)
  setCredential(region.tokenRef, token.accessToken)
  setCredential(region.metaRef, JSON.stringify({
    refreshToken: token.refreshToken,
    expiresAt,
    refreshExpiresAt,
    domain: token.domain.length > 0 ? token.domain : region.apiDomain,
    uid: account.uid,
    nickname,
    enterpriseId: account.enterpriseId,
    accountType: account.accountType,
    updatedAt: now
  }))
  // A successful login makes the deployment offerable again; without this the picker would
  // stay empty from the last logout.
  clearLoggedOut(region.id)
  registerAccount(region, { id, nickname, uid: account.uid, expiresAt, addedAt: now })
  return { account: id, nickname, uid: account.uid, expiresAt, refreshable: token.refreshToken.length > 0 }
}

/** The existing account that already holds this upstream identity, if any. */
function idOfSignedIn(region, uid) {
  if (typeof uid !== 'string' || uid.length === 0) return undefined
  for (const entry of listAccounts(region)) {
    if (entry.uid === uid) return entry.id
  }
  return undefined
}

/**
 * Begin (or report) one account's login. Resolves as soon as the auth URL
 * exists; the token poll continues in the background so the command returns
 * promptly and the user can finish the browser step at leisure.
 *
 * The first argument may be a bare region or a slot (`slotFor`): a bare region
 * means its account #1, which is what every caller that predates the pool —
 * and the `/workbuddy` command, which has no way to name an account — passes.
 * `options.account` exists for display, and the account a fresh login lands in
 * is decided when the token arrives (see below), not by the caller.
 * `{ fresh: true }` is 添加账号: the new account is appended, so it lands after
 * the existing ones in the fallback order.
 */
export async function beginLogin(ctx, region, options = {}) {
  const key = slotKey(region)
  const existing = prunePending(key)
  if (existing !== undefined) return { started: false, url: existing.url, pending: true }

  // A second 添加账号 while one is already waiting shows the flow that is running instead of
  // forking another. The key check above cannot catch this one: the id for an added account is
  // minted from the click, so every click gets a different key and several live flows pile up —
  // none of them visible in the panel and none of them cancellable.
  if (options.fresh === true) {
    const live = pendingLoginFor(region)
    if (live !== undefined) return { started: false, url: live.url, pending: true, account: live.account }
  }

  // Claimed before the request goes out: two concurrent calls would otherwise both
  // start a flow, and the first to fail would delete the second one's pending entry.
  const generation = authGeneration(region)
  pendingLogins.set(key, { url: '', startedAt: Date.now() })
  let authUrl
  let state
  try {
    const fetched = await fetchAuthState(region)
    state = fetched.state
    authUrl = decorateAuthUrl(fetched.authUrl, region)
    pendingLogins.set(key, { url: authUrl, startedAt: Date.now() })
  } catch (error) {
    pendingLogins.delete(key)
    throw error
  }
  if (options.open !== false) openInBrowser(authUrl)

  void (async () => {
    try {
      const token = await pollAuthToken(region, state)
      if (authGeneration(region) !== generation) {
        ctx.logger.info(`[workbuddy] ${key}: 登录结果已过期（期间退出或切换账号），不写回`)
        return
      }
      const account = await fetchAccount(region, token, state)
      if (authGeneration(region) !== generation) {
        ctx.logger.info(`[workbuddy] ${key}: 登录结果已过期（期间退出或切换账号），不写回`)
        return
      }
      // Where the result goes is decided now, not when the flow started: the user may
      // have signed into an account that is already in the pool, and re-authorizing it
      // must refresh that entry instead of adding a duplicate.
      const known = idOfSignedIn(region, account.uid)
      const target = known ?? (options.fresh === true ? newAccountId(account.uid || account.nickname || Date.now()) : accountOf(region))
      const slot = slotFor(region, target)
      const stored = storeCredential(ctx, slot, token, account)
      ctx.logger.info(`[workbuddy] ${target}: 已登录 ${stored.nickname || stored.uid || '(未知)'}`)
      await options.onSuccess?.(stored)
    } catch (error) {
      ctx.logger.warn(`[workbuddy] ${key}: 登录失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Only clear the entry this flow created; a newer flow owns its own.
      if (authGeneration(region) === generation) pendingLogins.delete(key)
    }
  })()
  return { started: true, url: authUrl, pending: false }
}

/**
 * The upstream identity behind one account slot: the uid it reported at login.
 *
 * Informational only. Per-account records are keyed by the *pool* account id — that is
 * the string the panel, the adapter and the sweep all share, whereas this uid is only
 * known after a login and is absent for a credential restored by hand. It is written
 * next to those records so a file on disk can be traced back to a person, and never used
 * as a key: doing that is what made every availability verdict invisible.
 */
export async function accountUidOf(ctx, region) {
  const meta = await readMeta(ctx, region)
  const uid = meta?.uid
  if (typeof uid === 'string' && uid.length > 0) return uid
  if (typeof uid === 'number') return String(uid)
  return undefined
}

/** One-line account summary for the command and the panel. */
export async function regionStatus(ctx, region) {
  const token = await readToken(ctx, region)
  const meta = await readMeta(ctx, region)
  const label = isPrimary(region) ? region.label : `${region.label}#${accountOf(region)}`
  if (token.length === 0) {
    const pending = prunePending(slotKey(region))
    return {
      loggedIn: false,
      text: `${label} (${region.provider}): 未登录${pending === undefined ? '' : ' — 浏览器授权进行中'}`
    }
  }
  const nickname = (typeof meta?.nickname === 'string' && meta.nickname.length > 0 ? meta.nickname : tokenNickname(token)) || '(未知)'
  const expiresAt = typeof meta?.expiresAt === 'number' && meta.expiresAt > 0 ? meta.expiresAt : tokenExpiryMs(token)
  const expired = typeof expiresAt === 'number' && expiresAt > 0 && Date.now() >= expiresAt
  const refreshable = typeof meta?.refreshToken === 'string' && meta.refreshToken.length > 0
  return {
    loggedIn: !expired,
    text: `${label} (${region.provider}): ${expired ? '已过期' : '已登录'}，账号 ${nickname}，到期 ${formatWhen(expiresAt)}，可续期：${refreshable ? '是' : '否'}`
  }
}

/**
 * The deployment as a whole, for a status command typed by hand.
 *
 * Several accounts per deployment is the normal case now, so one line per account is
 * the only honest summary — "signed in" says nothing about whether the second one is.
 */
export async function poolStatus(ctx, region) {
  const accounts = listAccounts(region)
  if (accounts.length === 0) {
    return { loggedIn: false, count: 0, text: (await regionStatus(ctx, region)).text }
  }
  const lines = []
  let signedIn = 0
  for (const entry of accounts) {
    const status = await regionStatus(ctx, slotFor(region, entry.id))
    if (status.loggedIn) signedIn += 1
    lines.push(`  ${status.text}`)
  }
  return {
    loggedIn: signedIn > 0,
    count: accounts.length,
    text: [`${region.label} (${region.provider}): ${accounts.length} 个账号，其中 ${signedIn} 个可用`, ...lines].join('\n')
  }
}

// Region definitions stay importable from here for callers that only need the
// deployment table alongside the auth helpers.
export { REGION_IDS, REGIONS }
