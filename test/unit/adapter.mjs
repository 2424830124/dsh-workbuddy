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

const { WorkBuddyAdapter } = await import('../../src/llm/adapter.js')
const { REGIONS } = await import('../../src/core/regions.js')

const BLOCKED = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the hy3 model. Instructions follow.'

// Tokens come from the plugin's own document (src/paths.js), so the fixture seeds it.
const { setCredential } = await import('../../src/core/paths.js')
setCredential(REGIONS.cn.tokenRef, 'header.payload.signature')
setCredential(REGIONS.intl.tokenRef, 'header.payload.signature')

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => undefined },
  get: () => undefined
}

const cn = new WorkBuddyAdapter(ctx, REGIONS.cn)
const intl = new WorkBuddyAdapter(ctx, REGIONS.intl)

// The only rewrite this route performs: the brand becomes a generic noun. Nothing
// else in the prompt is touched.
const sanitized = cn.sanitizeSystem(BLOCKED)
assert.ok(!/DeepSeek Harness/.test(sanitized), 'brand mentions are generalised')
assert.ok(sanitized.includes('powered by this harness'), 'rewritten in place, not removed')
assert.ok(sanitized.includes('You are a coding agent powered by the hy3 model. Instructions follow.'), 'the rest survives verbatim')

// Case-sensitive on purpose: the gateway matches the brand as published.
assert.equal(cn.sanitizeSystem('You are an AI agent powered by DeepSeek Harness.'), 'You are an AI agent powered by this harness.')
assert.equal(cn.sanitizeSystem('deepseek harness'), 'deepseek harness', 'other casings are left alone')
assert.equal(cn.sanitizeSystem('no brand here'), 'no brand here')

// Every mention is rewritten, not just the first.
assert.equal(cn.sanitizeSystem('A: DeepSeek Harness. B: DeepSeek Harness.'), 'A: this harness. B: this harness.')

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

// The harness answers a tool call with a message of its own:
//   { role: 'tool', source: { kind: 'tool', callId }, content: [...] }
// Converting that to a plain user message loses which call it answers, so the tool
// role and the call id have to survive the conversion.
const harnessTranscript = cn.buildBody({
  model: 'hy3',
  system: 'You are helpful.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '改一下文件' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '好' },
        { type: 'tool-call', id: 'call_1', name: 'write', arguments: '{"file_path":"a.txt","content":"b"}' }
      ]
    },
    { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text: 'written' }] }
  ]
}, 'hy3', undefined, undefined)
const toolMessage = harnessTranscript.messages.find((message) => message.role === 'tool')
assert.ok(toolMessage !== undefined, 'a tool result stays a tool message')
assert.equal(toolMessage.tool_call_id, 'call_1', 'and keeps the call id it answers')
assert.equal(toolMessage.content, 'written')
const assistantWithCall = harnessTranscript.messages.find((message) => Array.isArray(message.tool_calls))
assert.equal(assistantWithCall.tool_calls[0].id, 'call_1', 'the call survives because its result was found')
assert.ok(
  !harnessTranscript.messages.some((message) => message.role === 'user' && message.content === 'written'),
  'the tool output is not promoted to a user message'
)
// `developer` messages read as system to the wire.
const developerBody = cn.buildBody({
  model: 'hy3',
  system: 'You are helpful.',
  messages: [{ role: 'developer', content: [{ type: 'text', text: 'dev rules' }] }]
}, 'hy3', undefined, undefined)
assert.ok(developerBody.messages.some((message) => message.role === 'system' && message.content === 'dev rules'))

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
// The effort level is the whole reasoning control. Measured on both deployments:
// with `reasoning_effort` present, dropping `thinking:{type:'enabled'}` changes
// nothing at `high` and yields slightly more reasoning at `max`; the official
// client only sends the field when it turns thinking off.
assert.equal(chosen.thinking, undefined, 'no thinking flag is invented — the level carries the intent')

const undeclared = cn.buildBody({ model: declared.id, messages: [], reasoningEffort: 'xhigh' }, declared.id, declared, undefined)
assert.equal(undeclared.reasoning_effort, 'high', 'a level the model does not declare falls back to high, never to the raw value')

const silentDeepSeek = cn.buildBody({ model: declared.id, messages: [] }, declared.id, declared, undefined)
assert.equal(silentDeepSeek.reasoning_effort, 'high', 'a deepseek model with no selection still asks for the default level')
assert.equal(silentDeepSeek.thinking, undefined)

const otherFamily = withLevels('glm-5.2', ['low', 'medium', 'high'])
const otherChosen = cn.buildBody({ model: otherFamily.id, messages: [], reasoningEffort: 'medium' }, otherFamily.id, otherFamily, undefined)
assert.equal(otherChosen.reasoning_effort, 'medium', 'other families send the selected level too')
assert.equal(otherChosen.thinking, undefined, 'no thinking field is invented for any family')

// The same rule for every family, catalog-driven: with no selection the model's own
// declared default goes out, not a hard-coded level and not silence.
const otherSilent = cn.buildBody({ model: otherFamily.id, messages: [] }, otherFamily.id, otherFamily, undefined)
assert.equal(otherSilent.reasoning_effort, 'medium', 'a model with a declared default sends that default')

// A level the caller picked that the model does not declare falls back the same way.
const otherMismatch = cn.buildBody({ model: otherFamily.id, messages: [], reasoningEffort: 'max' }, otherFamily.id, otherFamily, undefined)
assert.equal(otherMismatch.reasoning_effort, 'medium', 'an undeclared level falls back to the catalog default')

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
    provider: '@huai_xin/dsh-workbuddy/cn',
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

// The same 429 carries two other meanings, and neither is retryable: an empty balance lasts
// until someone pays, and a used-up rate window lasts until its stated reset. Both were
// `RATE_LIMIT`, so a free-tier user watched five pointless retries and then the real reason.
const exhausted = async (status, body, expectCode) => {
  const adapter = new WorkBuddyAdapter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
    get: () => undefined
  }, REGIONS.intl)
  adapter.catalog = []
  adapter.catalogAt = Date.now()
  globalThis.fetch = async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })
  let caught
  try {
    for await (const chunk of adapter.stream({
      provider: '@huai_xin/dsh-workbuddy/intl',
      model: 'deepseek-v4.1-flash-sg',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: AbortSignal.timeout(10_000)
    })) void chunk
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== undefined, `expected a failure for ${expectCode}`)
  assert.equal(caught.code, expectCode)
  return caught
}

// 14018 is the real shape the overseas deployment returns (measured 2026-10-23).
const quota = await exhausted(429, JSON.stringify({
  error: { data: { code: 14018, msg: 'Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage', requestId: 'x' } }
}), 'QUOTA')
assert.match(quota.message, /积分已用尽/)
assert.match(quota.message, /充值/)
assert.match(quota.message, /Credits exhausted/, 'the upstream text stays for reference')

// The free tier's frequency window. Deliberately *not* QUOTA: the chat UI renders a QUOTA
// failure as its own fixed "当前请求的额度已用尽", which would tell the user to buy credits
// for something that resets by itself. Its own code is shown verbatim and is not retryable.
const window = await exhausted(429, JSON.stringify({
  code: 429,
  msg: "usage exceeds frequency limit, but don't worry, your usage will reset at 2026-10-24 09:54:53 UTC+8, alternatively, you can switch to the other models to continue using it."
}), 'RATE_WINDOW_EXCEEDED')
assert.match(window.message, /频率超限/)
assert.match(window.message, /2026-10-24 09:54:53/)
assert.match(window.message, /换用其它模型/)

// Neither is retryable, so neither may be spelled RATE_LIMIT.
assert.notEqual(quota.code, 'RATE_LIMIT')
assert.notEqual(window.code, 'RATE_LIMIT')
assert.notEqual(window.code, 'QUOTA', 'a window is not an empty balance')

// The mainland deployment says the same thing in Chinese, with business code 6004
// (measured 2026-10-24). Matching only the English wording left this falling through to a
// bare `HTTP_429` whose explanation was a wall of raw JSON.
const mainland = await exhausted(429, JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-10-24 09:54:53 UTC+8 重置，您也可以切换其他模型继续使用。',
  requestId: 'x'
}), 'RATE_WINDOW_EXCEEDED')
assert.match(mainland.message, /频率超限/)
assert.match(mainland.message, /2026-10-24 09:54:53 UTC\+8/, 'the reset time survives, timezone included')
assert.match(mainland.message, /换用其它模型/, 'and the suggestion is recognised in Chinese too')

// Busy *without* a queue: the overseas deployment answers a bare 429 whose text names the
// model, not the account (measured 2026-10-25: 模型繁忙，请换模型或稍后重试 too many requests).
// The gateway's own advice is "稍后重试", so this is transient — RATE_LIMIT, retried by the
// harness. It used to fall into the rate-window branch, which reported the account quota as
// gone for a hitch that lasts seconds.
const busy = await exhausted(429, JSON.stringify({
  code: 429,
  msg: '模型繁忙，请换模型或稍后重试 too many requests',
  requestId: 'x'
}), 'RATE_LIMIT')
assert.match(busy.message, /模型繁忙/)
assert.match(busy.message, /自动重试/)
assert.ok(!busy.message.includes('频率'), 'and it is not presented as a rate window')
assert.ok(!busy.message.includes('重置'), 'with no reset time, because none was stated')

// A bare 429 with none of the window's wordings is not proof of a window either: it stays a
// plain RATE_LIMIT instead of claiming a quota problem the body never stated.
const bare = await exhausted(429, JSON.stringify({ code: 429, msg: 'too many requests' }), 'RATE_LIMIT')
assert.ok(!bare.message.includes('频率超限'))

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

// ---------------------------------------------------------------------------
// Automatic continuation (the reference client's `streamRecovery`).
//
// A cut stream, or a stop that only produced reasoning, is continued once in-process
// so the user sees one answer instead of a silent ending.
// ---------------------------------------------------------------------------

const runRounds = async (responses) => {
  const adapter = new WorkBuddyAdapter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
    get: () => undefined
  }, REGIONS.cn)
  adapter.catalog = []
  adapter.catalogAt = Date.now()
  let call = 0
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    const response = responses[Math.min(call, responses.length - 1)]
    call += 1
    return streamOf(response)
  }
  const chunks = await collect(adapter)
  return { chunks, calls: call, bodies }
}

// 1) Cut before [DONE]: one continuation, and the user sees the second answer.
const cutThenAnswer = await runRounds([
  'data: {"choices":[{"delta":{"content":"改好"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"了，文件已写入。"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(cutThenAnswer.calls, 2, 'a cut stream is continued exactly once')
const recoveredText = cutThenAnswer.chunks
  .filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  .map((chunk) => chunk.block.text)
  .join('')
assert.ok(recoveredText.includes('改好'), 'the first attempt text survives')
assert.ok(recoveredText.includes('文件已写入'), 'and the continuation is appended')
assert.equal(cutThenAnswer.chunks.filter((chunk) => chunk.type === 'finish').length, 1, 'only one finish reaches the harness')
assert.equal(cutThenAnswer.chunks.at(-1).reason.kind, 'stop', 'the continuation decides the ending')
assert.ok(
  JSON.stringify(cutThenAnswer.bodies[1]).includes('incomplete draft'),
  'the continuation carries the draft'
)

// 2) A stop holding only reasoning: continued with shifted block indices.
const silentStop = await runRounds([
  'data: {"choices":[{"delta":{"reasoning_content":"先看目录…"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n',
  'data: {"choices":[{"delta":{"content":"已完成。"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(silentStop.calls, 2, 'a reasoning-only stop is continued')
const indexes = silentStop.chunks.filter((chunk) => typeof chunk.index === 'number').map((chunk) => chunk.index)
const reasoningEnd = silentStop.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'reasoning')
const textEnd = silentStop.chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
assert.equal(reasoningEnd.index, 0)
assert.equal(textEnd.index, 1, 'the continuation appends a new block instead of reusing index 0')
assert.ok(indexes.every((index) => Number.isInteger(index)))

// 3) A normal stop with an answer is not continued.
const plainStop = await runRounds([
  'data: {"choices":[{"delta":{"content":"改好了。"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(plainStop.calls, 1, 'a real answer ends the turn, no continuation')

// 4) A refusal is never continued.
const refusalStop = await runRounds([
  'data: {"choices":[{"delta":{"content":"我无法"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"refusal"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(refusalStop.calls, 1, 'a refusal is not retried')
assert.equal(refusalStop.chunks.at(-1).reason.kind, 'error')

// The ending is classified before the empty-response fallback: a refusal with no text
// is a refusal (not retryable), and a budget end with no deliverable content is
// max-tokens (the harness continues those), not an empty answer.
const emptyRefusal = await runRounds([
  'data: {"choices":[{"delta":{},"finish_reason":"refusal"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(emptyRefusal.chunks.at(-1).reason.kind, 'error')
assert.equal(emptyRefusal.chunks.at(-1).reason.failure.code, 'INVALID_REQUEST', 'an empty refusal is still not retryable')

const emptyBudget = await runRounds([
  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(emptyBudget.chunks.at(-1).reason.kind, 'max-tokens', 'an empty budget end continues the step')

// A body that throws while being read is a transport failure, not an UNKNOWN error.
const brokenBody = new WorkBuddyAdapter({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
  get: () => undefined
}, REGIONS.cn)
brokenBody.catalog = []
brokenBody.catalogAt = Date.now()
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'))
    controller.error(new TypeError('terminated'))
  }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const brokenChunks = await collect(brokenBody)
assert.equal(brokenChunks.at(-1).reason.kind, 'error', 'a network break ends with an error frame')
assert.equal(brokenChunks.at(-1).reason.failure.code, 'TRANSPORT', 'and is retryable instead of UNKNOWN')

// A tool call whose arguments are cut short must not be handed over — not even as a
// delta, because the assembler keeps an open tool block from the first delta.
const cutToolCall = await runRounds([
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"write","arguments":"{\\"file_path\\":\\"exa"}}]}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
    + 'data: [DONE]\n\n'
])
assert.equal(cutToolCall.chunks.at(-1).reason.kind, 'max-tokens')
assert.ok(
  !cutToolCall.chunks.some((chunk) => chunk.type === 'tool-call-delta'),
  'a truncated call emits no delta at all'
)
assert.ok(
  !cutToolCall.chunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'),
  'and no block end'
)

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
  'data: {"id":"chatcmpl-test-1","choices":[{"delta":{"content":"好了"}}]}',
  'data: {"id":"chatcmpl-test-1","choices":[{"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  ''
].join('\n\n'))
const completeFinish = (await collect(complete)).find((chunk) => chunk.type === 'finish')
assert.equal(completeFinish.reason.kind, 'stop', 'a normal ending still reads as stop')
// The finish chunk carries its own diagnostics: the session shows this block
// verbatim, which is how "who answered, and what did upstream call it" is answered
// without reconstructing it from the request headers.
assert.equal(completeFinish.response.kind, 'workbuddy')
assert.equal(completeFinish.response.provider, '@huai_xin/dsh-workbuddy/cn')
assert.equal(completeFinish.response.model, 'hy3')
assert.equal(completeFinish.response.responseId, 'chatcmpl-test-1')
assert.equal(completeFinish.response.stopReason, 'stop')
assert.deepEqual(completeFinish.response.blocks, [{ type: 'text' }])

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

// `finish_reason` carries more values than the three the docs mention, and the
// official CodeBuddy CLI maps the whole set. A refusal must not read as a stop.
const runWithFinishReason = async (finishReason) => {
  const adapter = new WorkBuddyAdapter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
    get: () => undefined
  }, REGIONS.cn)
  adapter.catalog = []
  adapter.catalogAt = Date.now()
  globalThis.fetch = async () => streamOf([
    'data: {"choices":[{"delta":{"content":"我无法"}}]}',
    `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}`,
    'data: [DONE]',
    ''
  ].join('\n\n'))
  const chunks = await collect(adapter)
  return chunks.find((chunk) => chunk.type === 'finish').reason
}

const refusal = await runWithFinishReason('refusal')
assert.equal(refusal.kind, 'error', 'a refusal is not a stop')
assert.equal(refusal.failure.code, 'INVALID_REQUEST', 'a refusal is not retryable')
assert.match(refusal.failure.message, /拒绝|过滤/)

const filtered = await runWithFinishReason('content_filter')
assert.equal(filtered.kind, 'error', 'content_filter is not a stop either')

const providerError = await runWithFinishReason('error')
assert.equal(providerError.kind, 'error')
assert.equal(providerError.failure.code, 'TRANSPORT', 'finish_reason=error is retryable')

const endTurn = await runWithFinishReason('end_turn')
assert.equal(endTurn.kind, 'stop', 'end_turn is the other spelling of stop')

const toolUse = await runWithFinishReason('tool_use')
assert.equal(toolUse.kind, 'tool-calls', 'tool_use is the Anthropic spelling of tool_calls')

// A tool-call fragment whose name never arrives cannot be announced, so it never
// reaches `toolOrder`. When upstream then says `stop`, the step used to read as "the
// model chose to stop" while a call was in flight — a silent drop. It must surface as
// a retryable error instead.
const collectCutCall = async (finishReason) => {
  const adapter = new WorkBuddyAdapter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    credentials: { resolve: async () => ({ value: 'header.payload.signature' }) },
    get: () => undefined
  }, REGIONS.cn)
  adapter.catalog = []
  adapter.catalogAt = Date.now()
  globalThis.fetch = async () => streamOf([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"arguments":"{\\"file_path\\":\\"a"}}]}}]}',
    `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}`,
    'data: [DONE]',
    ''
  ].join('\n\n'))
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: '@huai_xin/dsh-workbuddy/cn',
    model: 'hy3',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: AbortSignal.timeout(10_000)
  })) chunks.push(chunk)
  return { finish: chunks.find((chunk) => chunk.type === 'finish').reason, chunks }
}

const orphanStop = await collectCutCall('stop')
assert.equal(orphanStop.finish.kind, 'error', 'a call without a name is not a clean stop')
assert.equal(orphanStop.finish.failure.code, 'TRANSPORT', 'and it is retryable')
assert.match(orphanStop.finish.failure.message, /工具名/)
assert.ok(
  !orphanStop.chunks.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'),
  'the unusable call is not handed over'
)

const orphanClaimed = await collectCutCall('tool_calls')
assert.equal(orphanClaimed.finish.kind, 'error', 'even when upstream claims tool_calls, a nameless call is not delivered')

// The official client asks for usage explicitly; the request body must match.
assert.deepEqual(cn.buildBody({ model: 'hy3', messages: [] }, 'hy3', { id: 'hy3', name: 'Hy3', input: ['text'] }, undefined).stream_options, { include_usage: true })

console.log('adapter.mjs: OK — sanitizer, body assembly, routes, queue failure, and stream endings verified')
