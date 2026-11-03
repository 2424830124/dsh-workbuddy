/**
 * How a stream ended, as a table.
 *
 * `classifyEnding` is the one place that decides what the harness sees, so every
 * combination that matters is asserted here rather than inferred from stream fixtures.
 * The order of the rows is the order of the checks — see the comment in endings.js for
 * why that order is the point.
 */
import assert from 'node:assert/strict'

const { classifyEnding, isToolCallReason } = await import('../../src/llm/endings.js')

const PROVIDER = '@huai_xin/dsh-workbuddy/intl'
const base = { streamEnded: true, finishReason: 'stop', argsTruncated: false, orphanCalls: 0, blockCount: 1, hasTools: false }
const classify = (overrides) => classifyEnding({ ...base, ...overrides }, PROVIDER)

// --- ordinary endings -----------------------------------------------------
// The reason becomes the harness's finish chunk, which is rejected unless it survives a
// JSON round trip — so an absent note is omitted, never `undefined`.
assert.deepEqual(classify({}), { kind: 'stop' })
assert.equal(Object.hasOwn(classify({}), 'note'), false)
assert.equal(Object.hasOwn(classify({ finishReason: 'length' }), 'failure'), false, 'a non-error carries no failure key')
assert.equal(classify({ finishReason: 'end_turn' }).kind, 'stop')
assert.equal(classify({ finishReason: 'stop_sequence' }).kind, 'stop')
assert.equal(classify({ hasTools: true }).kind, 'tool-calls')
assert.equal(classify({ finishReason: 'tool_calls', hasTools: false }).kind, 'tool-calls', 'the reason alone is enough')
assert.equal(classify({ finishReason: 'tool_use', hasTools: false }).kind, 'tool-calls')
assert.equal(classify({ finishReason: 'function_call', hasTools: false }).kind, 'tool-calls')
assert.equal(classify({ finishReason: 'length' }).kind, 'max-tokens')
assert.equal(classify({ finishReason: 'max_tokens' }).kind, 'max-tokens')
assert.equal(classify({ finishReason: 'stop', blockCount: 0 }).kind, 'error', 'nothing delivered is empty')
assert.equal(classify({ blockCount: 0 }).failure?.code, 'EMPTY_RESPONSE')
assert.equal(classify({ finishReason: 'length', blockCount: 0 }).kind, 'max-tokens', 'an empty budget end continues the step')

// --- a stream that stopped without telling us why -------------------------
const cut = classify({ streamEnded: false, finishReason: undefined })
assert.equal(cut.kind, 'error')
assert.equal(cut.failure.code, 'TRANSPORT', 'a cut stream is retryable')
assert.equal(cut.note, 'cut')

// --- tool calls that can never be delivered -------------------------------
const orphan = classify({ orphanCalls: 2 })
assert.equal(orphan.kind, 'error')
assert.equal(orphan.failure.code, 'TRANSPORT')
assert.match(orphan.failure.message, /工具名/)

const argsCut = classify({ argsTruncated: true, streamEnded: false })
assert.equal(argsCut.kind, 'error')
assert.equal(argsCut.failure.code, 'TRANSPORT', 'truncated args on a cut stream are the cut')
assert.equal(argsCut.note, 'args-cut')

const argsBudget = classify({ argsTruncated: true })
assert.equal(argsBudget.kind, 'max-tokens', 'truncated args on a complete stream are the budget')
assert.equal(argsBudget.note, 'args-budget')

// --- the provider declining ----------------------------------------------
const refusal = classify({ finishReason: 'refusal' })
assert.equal(refusal.kind, 'error')
assert.equal(refusal.failure.code, 'INVALID_REQUEST', 'a refusal is not retryable')
assert.match(refusal.failure.message, /拒绝|过滤/)

const filtered = classify({ finishReason: 'content_filter', blockCount: 0 })
assert.equal(filtered.failure.code, 'INVALID_REQUEST', 'even with no text a filter is a filter')

const errorEnd = classify({ finishReason: 'error' })
assert.equal(errorEnd.kind, 'error')
assert.equal(errorEnd.failure.code, 'TRANSPORT', 'a provider error is retryable')

// --- precedence -----------------------------------------------------------
assert.equal(classify({ orphanCalls: 1, finishReason: 'refusal' }).failure.code, 'TRANSPORT', 'an undeliverable call outranks the reason')
assert.equal(classify({ streamEnded: false, finishReason: undefined, blockCount: 0 }).note, 'cut', 'the cut is reported as a cut, not as empty')
assert.equal(classify({ argsTruncated: true, finishReason: 'refusal' }).kind, 'max-tokens', 'the budget cut is checked before the refusal table')

// --- every message is prefixed with the provider --------------------------
assert.ok(classify({ finishReason: 'refusal' }).failure.message.startsWith(`${PROVIDER}: `))
assert.ok(classify({ blockCount: 0 }).failure.message.startsWith('模型返回了空响应'), 'the empty message is ours, no provider needed')

// --- sentence helpers -----------------------------------------------------
assert.equal(isToolCallReason('tool_calls'), true)
assert.equal(isToolCallReason('tool_use'), true)
assert.equal(isToolCallReason('stop'), false)
assert.equal(isToolCallReason(undefined), false)

console.log('endings.mjs: OK — the full ending table, its precedence, and the tool-call spellings verified')
