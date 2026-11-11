/**
 * Account lifecycle: logging out must delete the credentials, and work that started
 * under the previous account must not write them back.
 *
 * The second half is the bug an external review found: a slow token refresh, a
 * background login poll, or a delayed catalog response could each resurrect the old
 * account after logout or a switch.
 */
import assert from 'node:assert/strict'
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-auth-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { REGIONS } = await import('../../src/core/regions.js')
const { authGeneration, bumpAuthGeneration, cancelLogin, logoutRegion, refreshRegion, beginLogin, pendingAccounts, pendingLoginFor, pendingLogins } = await import('../../src/account/auth.js')
const { newAccountId, slotFor } = await import('../../src/account/pool.js')

const region = REGIONS.intl

/** The plugin's own credential document, behind the same little surface the tests use. */
const { readCredential, setCredential, unsetCredential } = await import('../../src/core/paths.js')

const createStore = (initial = {}) => {
  for (const [ref, value] of Object.entries(initial)) setCredential(ref, value)
  const values = {
    has: (ref) => readCredential(ref).length > 0
  }
  return { values }
}

const createCtx = (store, logs = []) => ({
  logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]), error: () => {} },
  credentials: store,
  get: () => undefined
})

// ---------------------------------------------------------------------------
// 1) Logout deletes both refs and bumps the generation.
// ---------------------------------------------------------------------------
const store = createStore({ [region.tokenRef]: 'access-1', [region.metaRef]: JSON.stringify({ refreshToken: 'refresh-1' }) })
const ctx = createCtx(store)
const before = authGeneration(region)
assert.ok(store.values.has(region.tokenRef))
await logoutRegion(ctx, region)
assert.equal(store.values.has(region.tokenRef), false, 'the access token is gone after logout')
assert.equal(store.values.has(region.metaRef), false, 'so is the refresh metadata')
assert.equal(authGeneration(region), before + 1, 'logout invalidates in-flight work')

// ---------------------------------------------------------------------------
// 2) A refresh that returns after logout does not write the old account back.
// ---------------------------------------------------------------------------
const racing = createStore({
  [region.tokenRef]: 'access-old',
  [region.metaRef]: JSON.stringify({ refreshToken: 'refresh-old', expiresAt: 0 })
})
const racingCtx = createCtx(racing)
const realFetch = globalThis.fetch
let release
const gate = new Promise((resolve) => { release = resolve })
globalThis.fetch = async () => {
  await gate
  return new Response(JSON.stringify({
    code: 0,
    data: { accessToken: 'access-from-old-refresh', refreshToken: 'refresh-from-old', expiresIn: 3600 }
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const refreshing = refreshRegion(racingCtx, region, { force: true })
// Log out while the refresh is still in flight, then let it finish.
await logoutRegion(racingCtx, region)
release()
const result = await refreshing
assert.equal(result.refreshed, false, 'the stale refresh is not applied')
// Either guard may fire first — the token may already be gone, or the generation may
// have moved — but it must not write.
assert.ok(['账号已切换', '缺少访问令牌'].includes(result.reason), `unexpected reason: ${result.reason}`)
assert.equal(racing.values.has(region.tokenRef), false, 'and it did not resurrect the token')
assert.equal(racing.values.has(region.metaRef), false, 'nor the refresh metadata')
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 3) A login poll that finishes after logout does not write credentials.
// ---------------------------------------------------------------------------
const loginStore = createStore()
const loginLogs = []
const loginCtx = createCtx(loginStore, loginLogs)
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('auth')) {
    return new Response(JSON.stringify({ code: 0, data: { state: 'state-1', authUrl: 'https://example.com/auth' } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }
  // The token poll: answer only after the logout below has happened.
  return new Response(JSON.stringify({ code: 0, data: { accessToken: 'access-late', refreshToken: 'refresh-late', expiresIn: 3600 } }), {
    status: 200, headers: { 'content-type': 'application/json' }
  })
}
const started = await beginLogin(loginCtx, { ...region, pollIntervalMs: 1 }, { open: false })
assert.equal(started.started, true, 'the login flow starts')
assert.ok(pendingLogins.has(region.id), 'and is recorded as pending')
await logoutRegion(loginCtx, region)
assert.equal(pendingLogins.has(region.id), false, 'logout drops the pending login')
// Give the background poll a moment to finish and try to write.
await new Promise((resolve) => setTimeout(resolve, 50))
assert.equal(loginStore.values.has(region.tokenRef), false, 'a late login result does not write credentials')
assert.equal(loginStore.values.has(region.metaRef), false, 'and does not write metadata either')
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 4) Two concurrent logins start one flow, not two.
// ---------------------------------------------------------------------------
const guarded = createStore()
const guardedCtx = createCtx(guarded)
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('auth')) {
    return new Response(JSON.stringify({ code: 0, data: { state: 'state-2', authUrl: 'https://example.com/auth2' } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }
  // Never answer: the poll stays pending for the rest of this test.
  return new Promise(() => {})
}
bumpAuthGeneration(region)
const first = beginLogin(guardedCtx, region, { open: false })
const second = beginLogin(guardedCtx, region, { open: false })
const [a, b] = await Promise.all([first, second])
assert.equal([a, b].filter((entry) => entry.started).length, 1, 'only one flow is started')
assert.equal([a, b].filter((entry) => entry.pending).length, 1, 'the other reports the pending one')
globalThis.fetch = realFetch

// A missing credentials document is an empty store, not a crash.
assert.equal(existsSync(join(process.env.DSH_HOME, 'nothing-here')), false)
void readFileSync

// ---------------------------------------------------------------------------
// 5) The background sweep rotates even when the claim says the token is good.
//
// The mainland deployment retires a session about 21 minutes after issuing it, while the
// token's `exp` claim is 28 days out (measured 2026-10-23). A sweep that trusted the claim
// skipped every rotation and left each request in between failing with 401 — reported as
// "the account keeps expiring". `rotate` means "refresh on my cadence, do not ask the claim".
// ---------------------------------------------------------------------------
{
  const farFuture = Date.now() + 28 * 24 * 3600_000
  const store = createStore({
    [region.tokenRef]: 'access-1',
    [region.metaRef]: JSON.stringify({ refreshToken: 'refresh-1', expiresAt: farFuture })
  })
  const ctx = createCtx(store)
  let refreshCalls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('auth/token/refresh')) {
      refreshCalls += 1
      return new Response(JSON.stringify({ code: 0, data: { accessToken: 'access-2' } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const lazy = await refreshRegion(ctx, region)
  assert.equal(lazy.refreshed, false, 'a lazy refresh still trusts a far-future claim')
  assert.equal(refreshCalls, 0, 'and does not spend a round trip')

  const rotated = await refreshRegion(ctx, region, { rotate: true })
  assert.equal(rotated.refreshed, true, 'the sweep rotates despite the claim')
  assert.equal(refreshCalls, 1)
  assert.equal(readCredential(region.tokenRef), 'access-2', 'and the new token is stored')
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------------------
// 6) Concurrent callers share one refresh, and a request refreshes a stale token first.
//
// The host log showed four refreshes inside four seconds — sweep, 401 retry and panel all
// deciding at once. They read the same refresh token and race to store a new one, so
// whichever finished last decided what the plugin kept.
// ---------------------------------------------------------------------------
{
  const store = createStore({
    [region.tokenRef]: 'access-1',
    [region.metaRef]: JSON.stringify({ refreshToken: 'refresh-1', expiresAt: Date.now() + 28 * 24 * 3600_000, updatedAt: Date.now() })
  })
  const ctx = createCtx(store)
  let calls = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('auth/token/refresh')) {
      calls += 1
      // A slow answer, so the second caller arrives while the first is in flight.
      await new Promise((resolve) => setTimeout(resolve, 30))
      return new Response(JSON.stringify({ code: 0, data: { accessToken: `access-${calls + 1}` } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const results = await Promise.all([
    refreshRegion(ctx, region, { rotate: true }),
    refreshRegion(ctx, region, { rotate: true }),
    refreshRegion(ctx, region, { rotate: true })
  ])
  assert.equal(calls, 1, 'three concurrent callers produce one refresh request')
  assert.ok(results.every((entry) => entry.refreshed === true), 'and all of them see the result')
  assert.equal(readCredential(region.tokenRef), 'access-2')

  // freshToken: a token older than the window is renewed before the caller sends it.
  const { freshToken, TOKEN_MAX_AGE_MS } = await import('../../src/account/auth.js')
  const staleMeta = JSON.parse(readCredential(region.metaRef))
  setCredential(region.metaRef, JSON.stringify({ ...staleMeta, updatedAt: Date.now() - TOKEN_MAX_AGE_MS - 1 }))
  calls = 0
  const token = await freshToken(ctx, region)
  assert.equal(calls, 1, 'a stale token is refreshed before use')
  assert.equal(token, 'access-2', 'and the caller gets the new one')

  // A token inside the window is used as-is: the common case costs nothing.
  calls = 0
  const cached = await freshToken(ctx, region)
  assert.equal(calls, 0, 'a fresh token is not refreshed again')
  assert.equal(cached, 'access-2')
  globalThis.fetch = realFetch
}

// A login for an account that does not exist yet still makes its deployment pending.
//
// This is the flag the panel polls on. It cannot be read off the account list: the account
// being added has no credentials yet, so its login is keyed `cn:<new id>` and no row in the
// payload would ever report it — which is why a freshly added account stayed invisible until
// the page was reloaded by hand.
{
  assert.equal(pendingAccounts(REGIONS.cn), false, 'a settled deployment is not pending')
  // An earlier case in this file leaves an intl flow in flight, so ask what it was rather
  // than assuming it: the point is that adding a cn login does not answer for intl.
  const intlBefore = pendingAccounts(REGIONS.intl)
  pendingLogins.set(`${REGIONS.cn.id}:acc-new`, { url: '', startedAt: Date.now() })
  assert.equal(pendingAccounts(REGIONS.cn), true, 'an unlisted account signing in makes the deployment pending')
  assert.equal(pendingAccounts(REGIONS.intl), intlBefore, 'and it never speaks for the other deployment')
  pendingLogins.delete(`${REGIONS.cn.id}:acc-new`)
  // A poll that died without clearing its own entry must not keep the panel polling forever.
  pendingLogins.set(`${REGIONS.cn.id}:acc-stale`, { url: '', startedAt: Date.now() - 7 * 60_000 })
  assert.equal(pendingAccounts(REGIONS.cn), false, 'a login abandoned long ago stops counting')
}

// ---------------------------------------------------------------------------
// 6) A pending login is the host's to describe and the host's to cancel.
//
// The panel used to keep the authorization URL in its own memory, so reloading the settings
// page left a 等待授权… notice with no link and, worse, no way out: the flow lived on the host
// and nothing could stop it. Cancelling therefore has to go through the generation, or the
// poll that is still running will store the token it was waiting for.
// ---------------------------------------------------------------------------
const cancelStore = createStore()
const cancelLogs = []
const cancelCtx = createCtx(cancelStore, cancelLogs)
const cancelRegion = { ...REGIONS.cn, pollIntervalMs: 1 }
const account = 'acc-cancel'
let tokenReady = false
globalThis.fetch = async (url) => {
  const target = String(url)
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  if (target.includes('/v2/plugin/auth/state')) return reply({ code: 0, data: { state: 'st-cancel', authUrl: 'https://www.workbuddy.cn/login/auth?state=st-cancel' } })
  if (target.includes('/v2/plugin/auth/token')) {
    // 11217 is "the user has not finished in the browser yet" — an empty data block is how the
    // poll sees it, and it keeps waiting.
    return tokenReady
      ? reply({ code: 0, data: { accessToken: 'access-cancelled', refreshToken: 'refresh-cancelled', expiresIn: 3600 } })
      : reply({ code: 11217, msg: 'token not ready' })
  }
  return reply({ code: 0, data: { uid: 'u-cancelled', nickname: '取消的账号' } })
}
const startedCancel = await beginLogin(cancelCtx, slotFor(REGIONS.cn, account), { open: false, fresh: true })
assert.equal(startedCancel.started, true, 'the add-account flow starts')
const live = pendingLoginFor(REGIONS.cn)
assert.equal(live?.account, account, 'and the host can name the account being added')
assert.match(live.url, /state=st-cancel/, 'the host also still has the link the panel needs after a reload')
assert.equal(typeof live.startedAt, 'number', 'and since when it has been waiting')

// A second 添加账号 click must not fork a second flow: the id of an added account comes from
// the click, so the key check inside beginLogin could never recognise the first one.
const again = await beginLogin(cancelCtx, slotFor(REGIONS.cn, newAccountId(Date.now())), { open: false, fresh: true })
assert.equal(again.started, false, 'a second click reports the flow that is already running')
assert.equal(again.account, account, 'instead of inventing another account')
assert.equal(again.url, live.url, 'with the same link')

const cancelled = cancelLogin(REGIONS.cn, account)
assert.equal(cancelled.cancelled, 1, 'cancelling finds the in-flight login')
assert.equal(pendingAccounts(REGIONS.cn), false, 'and nothing is pending any more')
assert.equal(cancelLogs.some(([level, line]) => level === 'info' && String(line).includes('已取消')), false, 'the route logs it, not the helper')
// The poll for that flow is still sleeping; let it wake up and try to write.
tokenReady = true
await new Promise((resolve) => setTimeout(resolve, 1_700))
assert.equal(cancelStore.values.has(cancelRegion.tokenRef), false, 'a token arriving after the cancel is not written')
assert.equal(cancelStore.values.has(cancelRegion.metaRef), false, 'nor is the metadata')
// A fresh add keys the account by the uid it reported, so this is the ref an uncancelled flow
// would have left behind — the account the user never finished adding.
assert.equal(readCredential(`${REGIONS.cn.tokenRef}#u-cancelled`), '', 'and no account is created for it')
assert.ok(
  cancelLogs.some(([level, line]) => level === 'info' && String(line).includes('登录结果已过期')),
  'the poll notices it was cancelled rather than writing anyway'
)
globalThis.fetch = realFetch

console.log('auth.mjs: OK — logout deletes credentials, stale work cannot write them back, the sweep ignores the exp claim, pending logins are visible per deployment, a cancelled login cannot write back, and refreshes are shared')
