/**
 * Unit check for the Settings panel's Host routes: registration shape, the
 * offline state payload, credits/check-in parsing, input validation, the trust
 * fence, and the manual claim route.
 *
 * The meter endpoints are stubbed on `globalThis.fetch`, so this stays offline,
 * and the catalog cache is pointed at a scratch directory so a real one cannot
 * answer for the stubbed-out live sources.
 *
 * Run: `node test/unit/api.mjs`
 */

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-api-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { registerWorkbuddyApi } = await import('../../src/panel/api.js')

const routes = []
// The plugin owns its credentials now: they live in $DSH_HOME/dsh-workbuddy/credentials.json.
const { setCredential, unsetCredential } = await import('../../src/core/paths.js')
const store = {
  set: (ref, value) => setCredential(ref, value),
  unset: (ref) => unsetCredential(ref),
  has: () => false
}
let rejection

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
})

let meterRequests = 0
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/billing/meter/get-user-resource')) {
    meterRequests += 1
    return json({
      code: 0,
      msg: 'OK',
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: '每日签到包',
                CapacityUnit: 'credits',
                Status: 0,
                ExpiredTime: '',
                CycleCapacityRemainPrecise: '120',
                CycleCapacitySizePrecise: '200',
                AccountAttributes: [{ Key: 'grantSource', Value: 'daily_checkin' }]
              },
              {
                PackageName: '付费包',
                CapacityUnit: 'credits',
                Status: 0,
                ExpiredTime: '',
                CycleCapacityRemainPrecise: '80.5'
              },
              { PackageName: '过期包', CycleCapacityRemainPrecise: '999', Status: 3 }
            ]
          }
        }
      }
    })
  }
  if (target.includes('/billing/meter/checkin-status')) {
    return json({
      code: 0,
      data: { active: true, today_checked_in: false, streak_days: 3, daily_credit: 50, week_progress: [true, true, true, false, false, false, false] }
    })
  }
  if (target.includes('/billing/meter/daily-checkin')) {
    return json({ code: 0, data: { credit: 50, streak_days: 4 } })
  }
  throw new Error(`unexpected fetch: ${target}`)
}

/** Every `llm/adapters-updated` notification the panel triggered. */
const topologyNotices = []

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  // Kept on the surface because the routes still receive the context; the plugin reads
  // its own document instead (src/paths.js).
  credentials: {
    resolve: async () => undefined,
    set: async () => {},
    unset: async () => {}
  },
  // The client's model directory only re-reads the catalog when the host says
  // the model set changed, so every mutating route must reach this hook.
  emit: (event) => { if (event === 'llm/adapters-updated') topologyNotices.push(Date.now()) },
  llm: { emitAdaptersUpdated: () => { topologyNotices.push(Date.now()) } },
  get: (name) => (name === 'connection' ? { requestRejection: () => rejection } : undefined),
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    }
  }
}

/** A route-mounting stand-in: the tests here never talk to a real catalog. */
const fakeAdapter = {
  catalogSource: 'none',
  models: async () => [],
  invalidateCatalog: () => {}
}

/** Records what the panel asked the browser to open; never launches one. */
const openedUrls = []

registerWorkbuddyApi(ctx, { cn: fakeAdapter }, { openInBrowser: (url) => { openedUrls.push(url); return true } })
assert.equal(routes.length, 1)
const route = routes[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/workbuddy')

const makeRes = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(name, value) { this.headers[name] = value },
  end(body) { this.body = body ?? '' }
})

async function call(method, url, body) {
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    }
  }
  const res = makeRes()
  await route.handler(req, res)
  return { status: res.statusCode, json: res.body.length > 0 ? JSON.parse(res.body) : null }
}

// Offline: no credentials, and no meter traffic at all.
const state = await call('GET', '/workbuddy/state')
assert.equal(state.status, 200)
assert.equal(state.json.regions.length, 2)
assert.deepEqual(state.json.regions.map((region) => region.id), ['cn', 'intl'], 'the mainland deployment is listed first')
assert.equal(state.json.regions[0].loggedIn, false)
assert.equal(state.json.regions[0].provider, '@huai_xin/dsh-workbuddy/cn')
assert.equal(state.json.regions[1].provider, '@huai_xin/dsh-workbuddy/intl')
assert.equal(state.json.regions[0].credits, null)
assert.equal(meterRequests, 0)

const badRegion = await call('POST', '/workbuddy/login', { region: 'mars' })
assert.equal(badRegion.status, 400)

const badBody = await call('POST', '/workbuddy/logout', { nope: true })
assert.equal(badBody.status, 400)

const missing = await call('GET', '/workbuddy/unknown')
assert.equal(missing.status, 404)

const notPost = await call('GET', '/workbuddy/login')
assert.equal(notPost.status, 404)

rejection = 403
const fenced = await call('GET', '/workbuddy/state')
assert.equal(fenced.status, 403)

// Signed in: credits + check-in come from the (stubbed) meter endpoints.
rejection = undefined
store.set('WORKBUDDY_CN_TOKEN', 'header.payload.signature')
store.set('WORKBUDDY_CN_ACCOUNT', JSON.stringify({
  refreshToken: 'refresh',
  expiresAt: Date.now() + 3600_000,
  nickname: 'tester'
}))
const withToken = await call('GET', '/workbuddy/state')
assert.equal(withToken.status, 200)
const cn = withToken.json.regions[0]
assert.equal(cn.loggedIn, true)
assert.equal(cn.nickname, 'tester')
assert.equal(cn.models, 0)
assert.equal(cn.credits.ok, true)
assert.equal(cn.credits.total, 200.5, 'the expired package must not count')
assert.equal(cn.credits.daily, 120)
assert.equal(cn.checkin.supported, true)
assert.equal(cn.checkin.todayCheckedIn, false)
assert.equal(cn.checkin.streakDays, 3)
assert.equal(cn.checkin.weekProgress.length, 7)
assert.ok(meterRequests >= 1, 'the balance must be read for a signed-in account')

// The international deployment has no check-in endpoint.
assert.equal(withToken.json.regions[1].checkin, null)

// An expired token reads as expired rather than logged in.
store.set('WORKBUDDY_CN_ACCOUNT', JSON.stringify({ refreshToken: 'refresh', expiresAt: Date.now() - 1000 }))
const expired = await call('GET', '/workbuddy/state')
assert.equal(expired.json.regions[0].loggedIn, false)

// Manual claim writes the outcome back onto the account metadata.
store.set('WORKBUDDY_CN_ACCOUNT', JSON.stringify({ refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 }))
const claimed = await call('POST', '/workbuddy/checkin', { region: 'cn' })
assert.equal(claimed.status, 200)
assert.equal(claimed.json.claimed, true)
assert.equal(claimed.json.credit, 50)
assert.equal(claimed.json.regions[0].lastClaim.credit, 50)
assert.equal(claimed.json.regions[0].lastClaim.reason, '手动')

const unsupported = await call('POST', '/workbuddy/checkin', { region: 'intl' })
assert.equal(unsupported.status, 200)
assert.equal(unsupported.json.claimed, false)

// ---------------------------------------------------------------------------
// Whatever changes the set of offered models has to tell the harness, or the
// picker keeps showing models the panel already switched off (it caches the
// catalog until `llm/adapters-updated` arrives).
// ---------------------------------------------------------------------------

const noticesBefore = topologyNotices.length

const toggled = await call('POST', '/workbuddy/enabled', { region: 'cn', id: 'hy3', enabled: false })
assert.equal(toggled.status, 200)
assert.equal(topologyNotices.length, noticesBefore + 1, 'switching a model off notifies the harness')

const bulk = await call('POST', '/workbuddy/enabled', { region: 'cn', ids: ['hy3', 'glm-5.3'], enabled: true })
assert.equal(bulk.status, 200)
assert.equal(topologyNotices.length, noticesBefore + 2, 'a bulk switch notifies once')

const imported = await call('POST', '/workbuddy/import?region=cn', { models: ['hy3'], from: 'test' })
assert.equal(imported.status, 200)
assert.equal(topologyNotices.length, noticesBefore + 3, 'importing an account list notifies the harness')

const refreshed = await call('GET', '/workbuddy/models?region=cn&refresh=1')
assert.equal(refreshed.status, 200)
assert.equal(topologyNotices.length, noticesBefore + 4, 'a forced catalog refresh notifies the harness')

// Reads must stay silent: only mutations change what the picker may offer.
const beforeRead = topologyNotices.length
await call('GET', '/workbuddy/models?region=cn')
await call('GET', '/workbuddy/state')
assert.equal(topologyNotices.length, beforeRead, 'plain reads do not notify')

// A login notifies **when the token arrives**, not when the request returns.
//
// `beginLogin` answers immediately with a pending flag; the real token lands later in a poll,
// so the notification has to live in the `onSuccess` callback. The reported bug was a freshly
// signed-in account whose models stayed invisible until something else notified the picker —
// the log showed the account signing in and its models arriving, with the notice only ever
// appearing at logout.
//
// Asserted against the source rather than by calling the route: a real `/login` starts an
// authorization flow (and its listener), which an offline unit test must not do.
{
  const source = readFileSync(new URL('../../src/panel/api.js', import.meta.url), 'utf8')
  const start = source.indexOf('onSuccess: (')
  assert.ok(start > 0, 'the login route supplies an onSuccess callback')
  const body = source.slice(start, source.indexOf('})', start))
  assert.match(body, /invalidateCatalog\(\)/, 'the completed login invalidates the cached catalog')
  assert.match(body, /notifyModelTopology\(ctx\)/, 'and notifies the picker, which caches its list')
  // 添加账号 decides the account id when the token arrives, so everything after the login
  // has to key off the account that was written rather than the one the request named.
  assert.match(body, /stored\.account/, 'the callback acts on the account that was actually written')
  assert.match(body, /slotFor\(region, stored\.account\)/, 'and builds that account\'s slot from it')
}

// 添加账号 refreshes by itself: the region-level `pending` is answered from the in-flight
// logins, so a login for an account that does not exist yet still makes the panel poll. Read
// off the listed accounts it would always be false — which is why a freshly added account
// stayed invisible until the user reloaded the page by hand.
{
  const { pendingLogins } = await import('../../src/account/auth.js')
  pendingLogins.set('cn:acc-not-yet', { url: 'https://www.workbuddy.cn/login?state=st', startedAt: Date.now() })
  try {
    const during = await call('GET', '/workbuddy/state')
    const cnDuring = during.json.regions.find((entry) => entry.id === 'cn')
    assert.equal(cnDuring.pending, true, 'a deployment with an account signing in reports pending')
    assert.equal(cnDuring.accounts.some((entry) => entry.pending === true), false, 'no listed account could have said so: the account being added does not exist yet')
    assert.equal(cnDuring.loginUrl, 'https://www.workbuddy.cn/login?state=st', 'the host publishes the link itself, so a reloaded panel can still hand it over')
    assert.equal(typeof cnDuring.pendingSince, 'number', 'and says since when it has been waiting')
    assert.equal(during.json.regions.find((entry) => entry.id === 'intl').pending, false, 'the other deployment is untouched')
  } finally {
    pendingLogins.delete('cn:acc-not-yet')
  }
  const settled = await call('GET', '/workbuddy/state')
  assert.equal(settled.json.regions.find((entry) => entry.id === 'cn').pending, false, 'and it settles when the flow ends')
  assert.equal(settled.json.regions.find((entry) => entry.id === 'cn').loginUrl, null, 'with no link left behind')

  // 取消这次登录: the flow lives on the host, so cancelling has to clear it there and answer
  // with the state the panel redraws from — otherwise 等待授权… sits on screen with nothing to
  // click until the five-minute poll gives up.
  pendingLogins.set('cn:acc-cancel', { url: 'https://www.workbuddy.cn/login?state=st2', startedAt: Date.now() })
  const cancelled = await call('POST', '/workbuddy/login/cancel', { region: 'cn' })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.json.cancelled, 1, 'the in-flight login is cancelled')
  assert.equal(pendingLogins.has('cn:acc-cancel'), false, 'and is gone from the host')
  assert.equal(cancelled.json.regions.find((entry) => entry.id === 'cn').pending, false, 'which the returned state already reflects')
}

// A composition without the llm service (headless, or an older harness) must
// still serve every route: the notification is an optimisation, not a dependency.
const bareRoutes = []
registerWorkbuddyApi({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: ctx.credentials,
  get: () => undefined,
  webServer: { register: (route) => { bareRoutes.push(route); return () => {} } }
}, { cn: fakeAdapter })
const bare = bareRoutes[0]
const bareRes = makeRes()
await bare.handler({
  method: 'POST',
  url: '/workbuddy/enabled',
  headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ region: 'cn', id: 'hy3', enabled: false })) }
}, bareRes)
assert.equal(bareRes.statusCode, 200, 'a context without emit or llm still switches models')

// ---------------------------------------------------------------------------
// The plans link: the panel names a page, the host resolves the URL, so the
// route can never be talked into opening an arbitrary address or host.
// ---------------------------------------------------------------------------

const plansCn = await call('POST', '/workbuddy/open', { region: 'cn', page: 'plans' })
assert.equal(plansCn.status, 200)
assert.equal(plansCn.json.url, 'https://www.workbuddy.cn/profile/plans-usage')
assert.equal(plansCn.json.opened, true)
assert.deepEqual(openedUrls, [plansCn.json.url], 'the URL reaches the opener exactly once')

const plansIntl = await call('POST', '/workbuddy/open', { region: 'intl', page: 'plans' })
assert.equal(plansIntl.json.url, 'https://www.workbuddy.ai/profile/plans-usage', 'each deployment opens its own site')
assert.equal(openedUrls.length, 2)

const badPage = await call('POST', '/workbuddy/open', { region: 'cn', page: 'https://evil.example/steal' })
assert.equal(badPage.status, 400, 'a page outside the allowlist is refused')
const unknownOpenRegion = await call('POST', '/workbuddy/open', { region: 'nope', page: 'plans' })
assert.equal(unknownOpenRegion.status, 400)
assert.equal(openedUrls.length, 2, 'refused requests never reach the opener')

// A browser that refuses to launch is reported, not swallowed: the panel shows
// the URL instead.
const noBrowserRoutes = []
registerWorkbuddyApi(ctx, { cn: fakeAdapter }, { openInBrowser: () => false })
// (the registration above is the first one; a second registration is fine — the
// test only reads the reply shape from this one)
const closedRes = makeRes()
await route.handler({
  method: 'POST',
  url: '/workbuddy/open',
  headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ region: 'cn', page: 'plans' })) }
}, closedRes)
assert.equal(JSON.parse(closedRes.body).opened, true, 'the first registration keeps its opener')
void noBrowserRoutes

// The artwork is served by the same route table. A stale relative path here fails only at
// request time, which is how it reached a release once — so it is asserted: both files must
// resolve from wherever this module now lives.
const iconRes = makeRes()
await route.handler({ method: 'GET', url: '/workbuddy/icon', headers: {} }, iconRes)
assert.equal(iconRes.statusCode, 200, 'the panel icon is served')
assert.ok((iconRes.body?.length ?? 0) > 0, 'and it is not empty')

const maskRes = makeRes()
await route.handler({ method: 'GET', url: '/workbuddy/icon-mask', headers: {} }, maskRes)
assert.equal(maskRes.statusCode, 200, 'the alpha mask is served too')

// The default opener is loaded through a dynamic `import()` so the child-process helper is
// not pulled in at module load. A stale specifier there does not break the import of this
// module — it fails only when someone clicks 「套餐」, which is exactly how it shipped once:
// the role folders moved `api.js` but the dynamic path still said `./regions.js`.
//
// Resolving is asserted rather than launching: opening a browser in a test would be rude.
{
  const { existsSync } = await import('node:fs')
  const { dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const apiPath = fileURLToPath(new URL('../../src/panel/api.js', import.meta.url))
  const source = (await import('node:fs')).readFileSync(apiPath, 'utf8')
  const dynamic = [...source.matchAll(/import\('(\.[^']+)'\)/g)].map((match) => match[1])
  assert.ok(dynamic.length > 0, 'the opener is still late-bound')
  for (const specifier of dynamic) {
    const target = resolve(dirname(apiPath), specifier)
    assert.ok(existsSync(target), `dynamic import ${specifier} resolves (→ ${target})`)
  }
}

console.log('api.mjs: OK — routes, validation, trust fence, credits, check-in, state payload, topology notices, artwork, and the late-bound opener verified')
