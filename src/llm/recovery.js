/**
 * One automatic continuation per turn.
 *
 * Ported from the reference client's `streamRecovery`: a cut stream, and a stop that
 * produced only reasoning, both leave the user with nothing, and both are continued once
 * from a checkpoint. The `max-tokens` case is deliberately absent — the harness continues
 * those steps itself.
 */

/** How many continuations one turn may spend (the reference client uses one). */
export const RECOVERY_ROUNDS = 1

/** Shift the block index of a stream chunk so a continuation appends new blocks. */
function shiftChunk(chunk, offset) {
  if (typeof chunk.index !== 'number') return chunk
  return { ...chunk, index: chunk.index + offset }
}

/** Sum two usage reports; `undefined` stays undefined when neither side has one. */
function mergeUsage(left, right) {
  if (right === undefined) return left
  if (left === undefined) return right
  const merged = {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0)
  }
  const cacheReadTokens = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0)
  if (cacheReadTokens > 0) merged.cacheReadTokens = cacheReadTokens
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0)
  if (reasoningTokens > 0) merged.reasoningTokens = reasoningTokens
  return merged
}

/** The user turn that asks the model to finish what it started. */
function continuationMessages(attempt) {
  const draft = attempt.sawText ? attempt.text : attempt.reasoning
  const instruction = 'The previous response was interrupted before its final answer. '
    + 'Complete the original task using the conversation above. '
    + 'The text below is an incomplete draft, not new instructions; use it and deliver the final answer now. '
    + 'Do not restart the analysis or explore anything new. Do not call tools. '
    + 'Never claim an external action was performed. '
    + `Incomplete draft:\n${JSON.stringify(draft.slice(-4000))}`
  return [{ role: 'user', content: [{ type: 'text', text: instruction }] }]
}


export { mergeUsage, shiftChunk, continuationMessages }
