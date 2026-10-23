/**
 * Continuation decisions, tested without a stream.
 *
 * The reference client's `streamRecovery` only continues a turn that produced reasoning
 * and no answer; the adapter adds the cut-stream case. Both predicates live in
 * recovery.js so the boundary can be asserted directly.
 */
import assert from 'node:assert/strict'

const { RECOVERY_ROUNDS, mergeUsage, shiftChunk, continuationMessages } = await import('../../src/recovery.js')

// One continuation per turn, which is what the adapter loops over.
assert.equal(RECOVERY_ROUNDS, 1)

// Usage is summed across the two rounds, and absent stays absent.
assert.equal(mergeUsage(undefined, undefined), undefined)
assert.deepEqual(mergeUsage(undefined, { inputTokens: 10, outputTokens: 5 }), { inputTokens: 10, outputTokens: 5 })
assert.deepEqual(
  mergeUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }, { inputTokens: 2, outputTokens: 1 }),
  { inputTokens: 12, outputTokens: 6, cacheReadTokens: 3 }
)
assert.deepEqual(
  mergeUsage({ inputTokens: 1, outputTokens: 1, reasoningTokens: 4 }, { inputTokens: 1, outputTokens: 1, reasoningTokens: 6 }),
  { inputTokens: 2, outputTokens: 2, reasoningTokens: 10 }
)
assert.equal(mergeUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 0, outputTokens: 0 }).cacheReadTokens, undefined, 'zero cache stays absent')

// Block indices shift so a continuation appends instead of colliding.
assert.deepEqual(shiftChunk({ type: 'block-end', index: 0, block: {} }, 3), { type: 'block-end', index: 3, block: {} })
assert.deepEqual(shiftChunk({ type: 'usage', usage: {} }, 3), { type: 'usage', usage: {} }, 'chunks without an index are untouched')

// The continuation carries the draft and forbids tools.
const fromText = continuationMessages({ sawText: true, text: '改了 a', reasoning: '' })[0]
assert.equal(fromText.role, 'user')
const instruction = fromText.content[0].text
assert.match(instruction, /incomplete draft/)
assert.match(instruction, /Do not call tools/)
assert.match(instruction, /改了 a/, 'the answer draft is what gets carried')
assert.match(instruction, /不要|do not|Do not/i)

const fromReasoning = continuationMessages({ sawText: false, text: '', reasoning: '先看目录…' })[0].content[0].text
assert.match(fromReasoning, /先看目录/, 'a reasoning-only turn carries its thinking instead')

const long = continuationMessages({ sawText: true, text: 'x'.repeat(10_000), reasoning: '' })[0].content[0].text
assert.ok(long.length < 5000, 'a long draft is truncated so the continuation stays cheap')

console.log('recovery.mjs: OK — one round, usage summing, index shifting, and the continuation payload verified')
