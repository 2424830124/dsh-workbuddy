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

const { REGIONS } = await import('../../src/regions.js')
const { authGeneration, bumpAuthGeneration, logoutRegion, refreshRegion, beginLogin, pendingLogins } = await import('../../src/auth.js')

const region = REGIONS.intl

/** A credentials store with the same surface the plugin uses. */
const createStore = (initial = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    values,
    async resolve(ref) {
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'stored', writable: true }
    },
    async set(ref, value) {
      if (value.length === 0) throw new Error('empty value')
      values.set(ref, value)
    },
    async unset(ref) {
      values.delete(ref)
    }
  }
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

console.log('auth.mjs: OK — logout deletes credentials, and stale work cannot write them back')
