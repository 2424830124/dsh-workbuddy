/**
 * Manual end-to-end smoke test against the real China route.
 *
 * Exercises the adapter the way the agent loop does: list models, resolve one,
 * stream a reply, and stream a tool call. Requires `test/.token` (written
 * during development). Run: `node test/smoke.mjs`.
 */

import { readFileSync } from 'node:fs'
import { WorkBuddyAdapter } from '../../src/adapter.js'
import { REGIONS } from '../../src/regions.js'

const token = JSON.parse(readFileSync(new URL('../.token', import.meta.url), 'utf8'))
const store = new Map([
  [REGIONS.cn.tokenRef, token.accessToken],
  [REGIONS.cn.metaRef, JSON.stringify({
    refreshToken: token.refreshToken,
    expiresAt: Date.now() + (token.expiresIn ?? 0) * 1000,
    domain: token.domain,
    nickname: 'smoke-test'
  })]
])

const ctx = {
  logger: { info: (...args) => console.log('[info]', ...args), warn: (...args) => console.warn('[warn]', ...args), error: console.error },
  credentials: {
    resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
    set: async (ref, value) => { store.set(ref, value) }
  },
  get: () => undefined
}

/** Optional argv: the model to exercise (default deepseek-v4.1-flash). */
const model = process.argv[2] ?? 'deepseek-v4.1-flash'
const adapter = new WorkBuddyAdapter(ctx, REGIONS.cn)
console.log('chat route:', adapter.routes()[0].endpoint, '| model:', model)

const models = await adapter.listModels('workbuddy-cn')
console.log('listModels:', models.length, '->', models.slice(0, 6).map((entry) => entry.id).join(', '))

const resolved = await adapter.resolveModel('workbuddy-cn', model)
console.log('resolveModel:', JSON.stringify(resolved))

const chunks = []
for await (const chunk of adapter.stream({
  provider: 'workbuddy-cn',
  model,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'One word: is 1+1 equal to 2?' }] }],
  maxTokens: 512,
  signal: AbortSignal.timeout(90_000)
})) {
  chunks.push(chunk)
}

const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
const finish = chunks.find((chunk) => chunk.type === 'finish')
console.log('stream text:', JSON.stringify(text))
console.log('finish:', JSON.stringify(finish))
console.log('chunk types:', [...new Set(chunks.map((chunk) => chunk.type))].join(', '))

// Second pass: tool-call parsing, the part the agent loop depends on.
const toolChunks = []
for await (const chunk of adapter.stream({
  provider: 'workbuddy-cn',
  model,
  system: 'You are a helpful assistant. Call the get_weather tool whenever weather is asked about.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Beijing? Use the tool.' }] }],
  tools: [{
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] }
  }],
  maxTokens: 512,
  signal: AbortSignal.timeout(90_000)
})) {
  toolChunks.push(chunk)
}

const calls = toolChunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
const toolFinish = toolChunks.find((chunk) => chunk.type === 'finish')
console.log('tool calls:', JSON.stringify(calls.map((chunk) => chunk.block)))
console.log('tool finish:', JSON.stringify(toolFinish))
