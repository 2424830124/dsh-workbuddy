/**
 * How long does a model switch actually take, and where does the time go?
 *
 * Drives the real panel routes through the real plugin, then reports per-route wall time.
 * This is what the settings panel does on a toggle: POST /enabled, then GET /models,
 * GET /state and GET /busy — several of which re-read the catalog.
 *
 * Run: `node test/live/toggle-timing.mjs`
 */
import { registerWorkbuddyApi } from '../../src/panel/api.js'

const logs = []
const logger = { info: (m) => { logs.push(m) }, warn: (m) => { logs.push(m) }, error: (m) => { logs.push(m) } }

let handler
const ctx = {
  logger,
  get: () => undefined,
  effect: (fn) => { fn() },
  inject: () => {},
  llm: { registerAdapter: () => () => {} },
  commands: { register: () => {} },
  webServer: { register: (route) => { handler = route.handler; return () => {} } }
}

// The adapter surface the routes use, with a stand-in catalog so the numbers reflect route
// overhead rather than an upstream round trip.
const models = Array.from({ length: 30 }, (_, index) => ({
  id: `model-${index}`,
  name: `Model ${index}`,
  credits: `x0.${10 + index} credits`,
  efforts: ['low', 'high'],
  defaultEffort: 'high',
  input: ['text'],
  description: `model ${index}`
}))

const adapters = {}
for (const id of ['cn', 'intl']) {
  adapters[id] = {
    models: async () => models,
    catalogSource: 'scoped',
    catalogCachedAt: Date.now(),
    invalidateCatalog: () => {}
  }
}

const call = async (method, path, body) => {
  const res = {
    headersSent: false,
    writeHead: () => {},
    end: (text) => { res.body = text },
    setHeader: () => {}
  }
  const req = {
    method,
    url: path,
    on: (event, cb) => { if (event === 'data') cb(JSON.stringify(body ?? {})); if (event === 'end') cb() },
    destroy: () => {}
  }
  const started = performance.now()
  await handler(req, res)
  return { ms: performance.now() - started, body: res.body }
}

registerWorkbuddyApi(ctx, adapters)

const timings = []
for (const [label, method, path, body] of [
  ['GET  /state', 'GET', '/workbuddy/state', undefined],
  ['GET  /models cn', 'GET', '/workbuddy/models?region=cn', undefined],
  ['GET  /models intl', 'GET', '/workbuddy/models?region=intl', undefined],
  ['GET  /busy cn', 'GET', '/workbuddy/busy?region=cn', undefined],
  ['POST /enabled', 'POST', '/workbuddy/enabled', { region: 'cn', ids: ['model-3'], enabled: false }]
]) {
  await call(method, path, body).catch(() => undefined) // warm
  const { ms } = await call(method, path, body)
  timings.push([label, ms])
}

console.log('\n每条路由的耗时（catalog 已在内存，不含上游往返）:')
for (const [label, ms] of timings) console.log(`  ${label.padEnd(18)} ${ms.toFixed(1)} ms`)

const total = timings.reduce((sum, [, ms]) => sum + ms, 0)
console.log(`\n面板切换一次开关会串起来跑的最小集合:`)
console.log(`  POST /enabled + GET /models + GET /state  = ${(timings[4][1] + timings[1][1] + timings[0][1]).toFixed(1)} ms`)
console.log(`  再加上插件级快照刷新（/state + 2×/models + /busy） = ${(timings[4][1] + timings[1][1] + timings[0][1] + timings[0][1] + timings[1][1] + timings[2][1] + timings[3][1]).toFixed(1)} ms`)
console.log(`  （全部相加仅作参考：${total.toFixed(1)} ms）`)
