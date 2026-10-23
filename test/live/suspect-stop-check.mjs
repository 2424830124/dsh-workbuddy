/** Verify the "suspicious premature stop" warning fires with the raw reason. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'wb-suspect-test')

const { WorkBuddyAdapter } = await import('../../src/adapter.js')
const { REGIONS } = await import('../../src/regions.js')

const logs = []
const adapter = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: (...args) => logs.push(args.join(' ')), error: () => {} },
  credentials: { resolve: async () => ({ value: 'a.b.c' }) },
  get: () => undefined
}, REGIONS.intl)
adapter.catalog = []
adapter.catalogAt = Date.now()

globalThis.fetch = async () => new Response([
  'data: {"choices":[{"delta":{"content":"我需要先读取 src/index.js 才能改。"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  ''
].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })

for await (const chunk of adapter.stream({
  provider: 'workbuddy-intl',
  model: 'deepseek-v4.1-flash',
  system: 's',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  signal: AbortSignal.timeout(5000)
})) void chunk

console.log(logs.length > 0 ? `✓ 日志: ${logs[0]}` : '✗ 没触发')

// A normal ending must stay silent.
logs.length = 0
globalThis.fetch = async () => new Response([
  'data: {"choices":[{"delta":{"content":"改好了。"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  ''
].join('\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } })
for await (const chunk of adapter.stream({
  provider: 'workbuddy-intl',
  model: 'deepseek-v4.1-flash',
  system: 's',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  signal: AbortSignal.timeout(5000)
})) void chunk
console.log(logs.length === 0 ? '✓ 正常收尾不打扰' : `✗ 正常收尾也打了日志: ${logs[0]}`)
