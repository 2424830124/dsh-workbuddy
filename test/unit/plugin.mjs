/**
 * Unit check for the Host half: `apply()` must register both provider routes
 * and the `/workbuddy` command, and the command must answer offline states
 * without touching the network.
 *
 * Run: `node test/unit/plugin.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the catalog cache at a scratch directory *before* the plugin loads, so
// this test neither reads nor writes the real one: with no credentials the live
// catalogs fail, and a real cache would legitimately answer instead of nothing.
process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-plugin-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { apply } = await import('../../src/index.js')

const registrations = []
const commands = []
const apiRoutes = []
const injected = []
let disposer

const credentials = new Map()
const childContext = {
  effect: (factory) => { factory() },
  get: () => undefined,
  webServer: {
    register: (route) => {
      apiRoutes.push(route)
      return () => {}
    }
  }
}
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => (credentials.has(ref) ? { value: credentials.get(ref) } : undefined),
    set: async (ref, value) => { credentials.set(ref, value) },
    unset: async (ref) => { credentials.delete(ref) }
  },
  llm: {
    /**
     * The real registry duck-types the adapter: it reads `providerInfo()` and
     * `providerRetryPolicy()` **during registration**, and calls the rest when a
     * request needs them. A missing method is not a degraded provider, it is a
     * thrown `apply()` — no providers, no HTTP routes, a panel answering 404.
     * This stand-in therefore touches the same surface, so deleting a hook can
     * never pass here and fail in the app again.
     */
    registerAdapter: (providers, adapter) => {
      for (const provider of providers) {
        const info = adapter.providerInfo(provider)
        assert.equal(info.id, provider, 'providerInfo must echo the provider id')
        assert.ok(typeof info.name === 'string' && info.name.length > 0, 'providerInfo needs a name')
        assert.equal(typeof adapter.providerRetryPolicy, 'function', 'the registry calls providerRetryPolicy during registration')
        for (const method of ['listModels', 'resolveModel', 'prepareCall', 'imageRequestPricing', 'imageRequestTarget']) {
          assert.equal(typeof adapter[method], 'function', `the harness calls ${method}() on this adapter`)
        }
      }
      registrations.push({ providers, adapter })
      return () => {}
    }
  },
  commands: {
    register: (definition) => {
      commands.push(definition)
      return () => {}
    }
  },
  inject: (names, callback) => {
    injected.push(names)
    callback(childContext)
  },
  effect: (factory) => { disposer = factory() },
  get: () => undefined
}

apply(ctx)

assert.deepEqual(injected, [['webServer']])
assert.equal(apiRoutes.length, 1)
assert.equal(apiRoutes[0].path, '/workbuddy')
assert.equal(registrations.length, 2, 'expected two provider routes')
const providers = registrations.flatMap((entry) => entry.providers).sort()
assert.deepEqual(providers, ['workbuddy-cn', 'workbuddy-intl'])
assert.equal(commands.length, 1)
assert.equal(commands[0].name, 'workbuddy')

for (const { providers: owned, adapter } of registrations) {
  const provider = owned[0]
  const info = adapter.providerInfo(provider)
  assert.equal(info.id, provider)
  assert.ok(info.name.length > 0)
  // No credentials here and an empty cache directory, so both live catalogs
  // fail and the list is empty on purpose: there is no built-in table behind it.
  const models = await adapter.listModels(provider)
  assert.ok(Array.isArray(models))
  assert.equal(models.length, 0, `${provider} must not invent a catalog without an account`)
  assert.equal(adapter.catalogSource, 'none')
  // A model id the session already knows still resolves, so a catalog outage
  // cannot break an existing session.
  const resolved = await adapter.resolveModel(provider, 'deepseek-v4.1-flash')
  assert.equal(resolved.provider, provider)
  assert.equal(resolved.id, 'deepseek-v4.1-flash')
  assert.deepEqual(resolved.inputModalities, ['text'])
}

const handler = commands[0].handler
const status = await handler({ rawInput: '' })
assert.equal(status.kind, 'success')
assert.match(status.text, /未登录/)
assert.match(status.text, /check/, 'the help line lists the availability sweep')

const unknown = await handler({ rawInput: 'login mars' })
assert.equal(unknown.kind, 'error')

const badVerb = await handler({ rawInput: 'teleport cn' })
assert.equal(badVerb.kind, 'error')

// `check` with no account has nothing to probe and must say so rather than
// firing requests at a gateway it has no token for.
const check = await handler({ rawInput: 'check cn' })
assert.equal(check.kind, 'success')
assert.match(check.text, /没有可检测的模型/)

disposer?.()
console.log('plugin.mjs: OK — providers, catalog, command (incl. check), and HTTP routes verified')
