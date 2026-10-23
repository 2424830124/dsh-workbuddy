/**
 * WorkBuddy's plugin login protocol and the credentials it produces.
 *
 *   POST /v2/plugin/auth/state?platform=…   → { state, authUrl }
 *   GET  /v2/plugin/auth/token?state=…      → { accessToken, refreshToken, … }
 *   GET  /v2/plugin/login/account?state=…   → { uid, nickname, enterpriseId, … }
 *   POST /v2/plugin/auth/token/refresh      → rotated tokens
 *
 * The access token is stored under the region's `tokenRef` (a bare token: this
 * is what reaches the wire as the bearer value), and everything that rotates
 * around it — refresh token, expiry, account identity, last check-in outcome —
 * under `metaRef` as JSON.
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
import { resolveCredential, setCredential, unsetCredential } from '../core/paths.js'
import { clearLoggedOut, markLoggedOut } from '../catalog/model-prefs.js'
import { REGION_IDS, REGIONS, openInBrowser } from '../core/regions.js'

const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 1_500
/** Rotate once the access token is inside this window of expiring. */
const REFRESH_SKEW_MS = 24 * 3600_000
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

/** One in-flight login per region, so a repeated command reports instead of forking a second flow. */
export const pendingLogins = new Map()

/**
 * Account generations, one per region.
 *
 * Every asynchronous path that later writes credentials or a catalog compares the
 * generation it started under with the current one. Logging out or switching accounts
 * bumps it, so a slow refresh, a background login poll, or a delayed catalog response
 * that started before the switch can no longer resurrect the previous account.
 */
const generations = new Map()

export function authGeneration(region) {
  return generations.get(region.id) ?? 0
}

/** Invalidate in-flight work for this region and drop any pending login. */
export function bumpAuthGeneration(region) {
  generations.set(region.id, authGeneration(region) + 1)
  pendingLogins.delete(region.id)
  return authGeneration(region)
}

/**
 * Log out: invalidate in-flight work first, then delete the stored credentials.
 *
 * The order matters — a refresh that returns after the deletion would otherwise write
 * the old account straight back, which is exactly the bug this replaces.
 */
export async function logoutRegion(ctx, region) {
  bumpAuthGeneration(region)
  unsetCredential(region.tokenRef)
  unsetCredential(region.metaRef)
  // Hiding the models is part of logging out: the picker kept offering them because the
  // cached catalog and the hand decisions were still there, so a logged-out deployment
  // looked callable. The marker is cleared by `clearLoggedOut` on the next login.
  markLoggedOut(region.id)
  ctx.logger.info(`[workbuddy] ${region.id}: 已退出登录，凭据已删除，模型已从选择器移除`)
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

async function storeCredential(ctx, region, token, account) {
  const now = Date.now()
  const expiresAt = token.expiresIn > 0 ? now + token.expiresIn * 1000 : tokenExpiryMs(token.accessToken) ?? 0
  const refreshExpiresAt = token.refreshExpiresIn > 0 ? now + token.refreshExpiresIn * 1000 : 0
  const nickname = account.nickname.length > 0 ? account.nickname : tokenNickname(token.accessToken)
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
  return { nickname, expiresAt, refreshable: token.refreshToken.length > 0 }
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
 * Rotate one region's tokens when the access token is close to expiry.
 * Failures are logged, never thrown: a stale token must not break the plugin.
 */
export async function refreshRegion(ctx, region, options = {}) {
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
  ctx.logger.info(`[workbuddy] ${region.id}: 访问令牌已续期`)
  return { refreshed: true }
}

/**
 * Begin (or report) one region's login. Resolves as soon as the auth URL
 * exists; the token poll continues in the background so the command returns
 * promptly and the user can finish the browser step at leisure.
 */
export async function beginLogin(ctx, region, options = {}) {
  const existing = pendingLogins.get(region.id)
  if (existing !== undefined) return { started: false, url: existing.url, pending: true }

  // Claimed before the request goes out: two concurrent calls would otherwise both
  // start a flow, and the first to fail would delete the second one's pending entry.
  const generation = authGeneration(region)
  pendingLogins.set(region.id, { url: '', startedAt: Date.now() })
  let authUrl
  let state
  try {
    const fetched = await fetchAuthState(region)
    state = fetched.state
    authUrl = decorateAuthUrl(fetched.authUrl, region)
    pendingLogins.set(region.id, { url: authUrl, startedAt: Date.now() })
  } catch (error) {
    pendingLogins.delete(region.id)
    throw error
  }
  if (options.open !== false) openInBrowser(authUrl)

  void (async () => {
    try {
      const token = await pollAuthToken(region, state)
      if (authGeneration(region) !== generation) {
        ctx.logger.info(`[workbuddy] ${region.id}: 登录结果已过期（期间退出或切换账号），不写回`)
        return
      }
      const account = await fetchAccount(region, token, state)
      if (authGeneration(region) !== generation) {
        ctx.logger.info(`[workbuddy] ${region.id}: 登录结果已过期（期间退出或切换账号），不写回`)
        return
      }
      const stored = await storeCredential(ctx, region, token, account)
      ctx.logger.info(`[workbuddy] ${region.id}: 已登录 ${stored.nickname || stored.uid || '(未知)'}`)
      await options.onSuccess?.(stored)
    } catch (error) {
      ctx.logger.warn(`[workbuddy] ${region.id}: 登录失败 — ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Only clear the entry this flow created; a newer flow owns its own.
      if (authGeneration(region) === generation) pendingLogins.delete(region.id)
    }
  })()
  return { started: true, url: authUrl, pending: false }
}

/**
 * A stable identity for the logged-in account.
 *
 * Per-account records (availability verdicts, imported model lists) use it so one
 * account's entitlements do not leak into another's. The catalog itself stays shared:
 * which models a deployment offers is not an account fact.
 */
export async function accountIdOf(ctx, region) {
  const meta = await readMeta(ctx, region)
  const uid = meta?.uid
  if (typeof uid === 'string' && uid.length > 0) return uid
  if (typeof uid === 'number') return String(uid)
  const nickname = typeof meta?.nickname === 'string' ? meta.nickname.trim() : ''
  return nickname.length > 0 ? `nick:${nickname}` : undefined
}

/** One-line account summary for the command and the panel. */
export async function regionStatus(ctx, region) {
  const token = await readToken(ctx, region)
  const meta = await readMeta(ctx, region)
  if (token.length === 0) {
    const pending = pendingLogins.get(region.id)
    return {
      loggedIn: false,
      text: `${region.label} (${region.provider}): 未登录${pending === undefined ? '' : ' — 浏览器授权进行中'}`
    }
  }
  const nickname = (typeof meta?.nickname === 'string' && meta.nickname.length > 0 ? meta.nickname : tokenNickname(token)) || '(未知)'
  const expiresAt = typeof meta?.expiresAt === 'number' && meta.expiresAt > 0 ? meta.expiresAt : tokenExpiryMs(token)
  const expired = typeof expiresAt === 'number' && expiresAt > 0 && Date.now() >= expiresAt
  const refreshable = typeof meta?.refreshToken === 'string' && meta.refreshToken.length > 0
  return {
    loggedIn: !expired,
    text: `${region.label} (${region.provider}): ${expired ? '已过期' : '已登录'}，账号 ${nickname}，到期 ${formatWhen(expiresAt)}，可续期：${refreshable ? '是' : '否'}`
  }
}

// Region definitions stay importable from here for callers that only need the
// deployment table alongside the auth helpers.
export { REGION_IDS, REGIONS }
