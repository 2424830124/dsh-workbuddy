/**
 * Unit check for the China system-prompt sanitizer: the one anchored
 * fingerprint the gateway blocks must be rewritten, everything else must pass
 * through untouched (including the international deployment's prompt).
 *
 * Run: `node test/unit/adapter.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A scratch cache directory, so the queue-failure case below exercises the
// "no live source and no cache" path instead of picking up a real snapshot.
process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-adapter-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { WorkBuddyAdapter } = await import('../../src/adapter.js')
const { REGIONS } = await import('../../src/regions.js')

const BLOCKED = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the hy3 model. Instructions follow.'

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => undefined },
  get: () => undefined
}

const cn = new WorkBuddyAdapter(ctx, REGIONS.cn)
const intl = new WorkBuddyAdapter(ctx, REGIONS.intl)

const sanitized = cn.sanitizeSystem(BLOCKED)
assert.ok(!/^\s*you are an ai agent powered by deepseek harness/i.test(sanitized), 'the blocked opening must be gone')
assert.ok(sanitized.startsWith('You are an AI agent.'), 'replaced with the neutral opening')
assert.ok(sanitized.includes('You are a coding agent powered by the hy3 model. Instructions follow.'), 'the rest survives verbatim')

// Case-insensitive and punctuation-tolerant, as the gateway is.
assert.equal(cn.sanitizeSystem('you are an ai agent powered by deepseek harness'), 'You are an AI agent.')
assert.equal(cn.sanitizeSystem('  You are an AI agent powered by DeepSeek Harness.  rest'), 'You are an AI agent.  rest')

// Anything else is left alone.
assert.equal(cn.sanitizeSystem('You are a coding agent powered by DeepSeek Harness.'), 'You are a coding agent powered by DeepSeek Harness.')
assert.equal(cn.sanitizeSystem('Hello. You are an AI agent powered by DeepSeek Harness.'), 'Hello. You are an AI agent powered by DeepSeek Harness.')

// One prompt shape for both deployments.
assert.equal(intl.sanitizeSystem(BLOCKED), cn.sanitizeSystem(BLOCKED), 'the international route rewrites it the same way')

// buildBody applies it to the request's own system field and to any system
// message carried in history.
const body = cn.buildBody({
  model: 'hy3',
  system: BLOCKED,
  messages: [
    { role: 'system', content: BLOCKED },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  ]
}, 'hy3', undefined, undefined)
assert.equal(body.messages[0].role, 'system')
assert.ok(!/powered by deepseek harness/i.test(body.messages[0].content))
assert.equal(body.messages.length, 3, 'request system + history system + user')
assert.ok(!/powered by deepseek harness/i.test(body.messages[1].content), 'a history system message is sanitized too')

// China chats through the CodeBuddy China gateway; the web host stays as fallback.
const routes = cn.routes()
assert.equal(routes[0].endpoint, 'https://copilot.tencent.com')
assert.equal(routes[0].productCode, 'workbuddy')
assert.equal(routes[1].endpoint, 'https://www.workbuddy.cn')
assert.equal(intl.routes().length, 1, 'the international deployment has a single route')
assert.equal(intl.routes()[0].endpoint, 'https://www.workbuddy.ai')

// ---------------------------------------------------------------------------
// The reasoning controls. `reasoning_effort` is a real, gateway-validated field
// (an unknown value is refused with 11133 on deepseek) and it is what makes an
// optional-thinking model think at all, so the body must carry the level the
// harness selected, the deepseek fallback must stay, and nothing may be invented
// for a model that declares no levels or is outside the verified family.
// ---------------------------------------------------------------------------
const withLevels = (id, levels, isDeepSeek = false) => ({
  id,
  name: id,
  input: ['text'],
  efforts: Object.fromEntries(levels.map((level) => [level, level])),
  defaultEffort: levels[1] ?? levels[0],
  ...(isDeepSeek ? { thinking: true } : {}),
  official: true,
  preset: false
})

const declared = withLevels('deepseek-v4.1-flash', ['low', 'high', 'max'], true)
const chosen = cn.buildBody({ model: declared.id, messages: [], reasoningEffort: 'max' }, declared.id, declared, undefined)
assert.equal(chosen.reasoning_effort, 'max', 'the selected level reaches the request')
assert.deepEqual(chosen.thinking, { type: 'enabled' }, 'the deepseek family is pinned to thinking on')

const undeclared = cn.buildBody({ model: declared.id, messages: [], reasoningEffort: 'xhigh' }, declared.id, declared, undefined)
assert.equal(undeclared.reasoning_effort, 'high', 'a level the model does not declare falls back to high, never to the raw value')

const silentDeepSeek = cn.buildBody({ model: declared.id, messages: [] }, declared.id, declared, undefined)
assert.equal(silentDeepSeek.reasoning_effort, 'high', 'a deepseek model with no selection still asks for the default level')
assert.deepEqual(silentDeepSeek.thinking, { type: 'enabled' })

const otherFamily = withLevels('glm-5.2', ['low', 'medium', 'high'])
const otherChosen = cn.buildBody({ model: otherFamily.id, messages: [], reasoningEffort: 'medium' }, otherFamily.id, otherFamily, undefined)
assert.equal(otherChosen.reasoning_effort, 'medium', 'other families send the selected level too')
assert.equal(otherChosen.thinking, undefined, 'no invented thinking field outside the verified family')

const noLevels = cn.buildBody({ model: 'hy3', messages: [], reasoningEffort: 'high' }, 'hy3', { id: 'hy3', name: 'Hy3', input: ['text'] }, undefined)
assert.equal(noLevels.reasoning_effort, undefined, 'a model with no declared levels gets no reasoning field')

// A busy model answers HTTP 429 with business code 6020 and the untranslated
// key `queue.waiting.title`; the failure must read like a queue notice and stay
// a plain RATE_LIMIT, so the harness's own exponential backoff owns the cadence
// (no upstream retry-after hint is forwarded).
const queueBody = JSON.stringify({
  code: 6020,
  msg: 'queue.waiting.title',
  requestId: 'req-1',
  data: { queue_position: 1144, queue_size: '999+', retry_after: 40 }
})
const live = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
  get: () => undefined
}, REGIONS.cn)
live.catalog = []
live.catalogAt = Date.now()
globalThis.fetch = async () => new Response(queueBody, { status: 429, headers: { 'content-type': 'application/json' } })

let failure
try {
  for await (const chunk of live.stream({
    provider: 'workbuddy-cn',
    model: 'hy3',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: AbortSignal.timeout(10_000)
  })) void chunk
} catch (error) {
  failure = error
}
assert.ok(failure !== undefined, 'the queue response must surface as an error')
assert.equal(failure.code, 'RATE_LIMIT')
assert.equal(failure.status, 429)
assert.equal(failure.providerRetryAfterMs, undefined, 'the upstream retry-after hint is not forwarded')
assert.equal(failure.failure.providerRetryAfterMs, undefined)
assert.match(failure.message, /排队中/)
assert.match(failure.message, /第 1144 位/)
assert.match(failure.message, /自动重试/)
assert.ok(!failure.message.includes('queue.waiting.title'), 'the raw i18n key must not reach the transcript')

// ---------------------------------------------------------------------------
// How a stream ends decides whether a short answer is retried or silently kept.
//
// A response cut before the `[DONE]` sentinel used to read as a normal `stop`:
// the turn ended as if the model had chosen to stop, the retry policy never saw a
// failure, and an answer that was about to call a tool just stopped.
// ---------------------------------------------------------------------------

const streamOf = (sse) => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
const collect = async (adapter) => {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: adapter.region.provider,
    model: 'hy3',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: AbortSignal.timeout(10_000)
  })) chunks.push(chunk)
  return chunks
}

const cut = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
  get: () => undefined
}, REGIONS.cn)
cut.catalog = []
cut.catalogAt = Date.now()
globalThis.fetch = async () => streamOf('data: {"choices":[{"delta":{"content":"我准备调用"}}]}\n\n')
const cutChunks = await collect(cut)
const cutFinish = cutChunks.find((chunk) => chunk.type === 'finish')
assert.equal(cutFinish.reason.kind, 'error', 'a stream cut before [DONE] must not read as a clean stop')
assert.equal(cutFinish.reason.failure.code, 'TRANSPORT', 'the harness can retry a transport failure')
assert.match(cutFinish.reason.failure.message, /中断/)
// The remote's own reason is not observable, so the report has to carry the
// circumstances: how much arrived, how long it took, and what was being written.
assert.match(cutFinish.reason.failure.message, /收到 \d/, 'the report says how much arrived')
assert.match(cutFinish.reason.failure.message, /用时 [\d.]+s/)
assert.match(cutFinish.reason.failure.message, /中断时正在输出正文/)

// A stream cut while a tool call was still arriving is the same kind of failure,
// and it must not be mistaken for a budget truncation: there was no terminator.
const cutCall = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
  get: () => undefined
}, REGIONS.cn)
cutCall.catalog = []
cutCall.catalogAt = Date.now()
globalThis.fetch = async () => streamOf(
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a"}}]}}]}\n\n'
)
const cutCallFinish = (await collect(cutCall)).find((chunk) => chunk.type === 'finish')
assert.equal(cutCallFinish.reason.failure.code, 'TRANSPORT', 'a cut mid tool call is retryable, not a budget truncation')
assert.match(cutCallFinish.reason.failure.message, /中断时正在输出工具调用/)

const complete = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
  get: () => undefined
}, REGIONS.cn)
complete.catalog = []
complete.catalogAt = Date.now()
globalThis.fetch = async () => streamOf([
  'data: {"choices":[{"delta":{"content":"好了"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  ''
].join('\n\n'))
const completeFinish = (await collect(complete)).find((chunk) => chunk.type === 'finish')
assert.equal(completeFinish.reason.kind, 'stop', 'a normal ending still reads as stop')

const budget = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
  get: () => undefined
}, REGIONS.cn)
budget.catalog = []
budget.catalogAt = Date.now()
globalThis.fetch = async () => streamOf([
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
  'data: [DONE]',
  ''
].join('\n\n'))
const budgetChunks = await collect(budget)
const budgetFinish = budgetChunks.find((chunk) => chunk.type === 'finish')
assert.equal(budgetFinish.reason.kind, 'max-tokens', 'a complete stream that ran out of budget is still max-tokens')
assert.ok(
  !budgetChunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'),
  'a tool call with truncated arguments is not handed over — it cannot be executed'
)

console.log('adapter.mjs: OK — sanitizer, body assembly, routes, queue failure, and stream endings verified')
