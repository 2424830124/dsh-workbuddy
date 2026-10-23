/**
 * How a stream ended, and what that ending means.
 *
 * Pure: it takes what the stream turned out to contain and returns the reason the
 * harness should see. Keeping it out of the adapter means every combination can be
 * asserted in one table (see `test/unit/endings.mjs`) instead of being inferred from
 * a handful of stream fixtures.
 *
 * The order matters and is the point of this file:
 *
 * 1. a tool call that never got a name cannot be delivered — a silent drop looks
 *    exactly like the model choosing to stop, so it is a retryable transport error;
 * 2. a stream that ends without `[DONE]` and without a reason was cut;
 * 3. truncated tool arguments on a cut stream are the same cut;
 * 4. truncated tool arguments on a complete stream are an output-budget truncation;
 * 5. `refusal` / `content_filter` are the provider declining — not a stop, not
 *    retryable;
 * 6. `error` is the provider giving up mid-answer — retryable;
 * 7. only then does "nothing usable arrived" become an empty response;
 * 8. and only then do tools / budget / stop decide the ordinary endings.
 */

/** `finish_reason` values that mean the provider declined to answer. */
const REFUSALS = new Set(['refusal', 'content_filter'])
/** `finish_reason` values that mean the answer ran into the output budget. */
const BUDGETS = new Set(['length', 'max_tokens'])
/** `finish_reason` values that mean the model wants a tool executed. */
const TOOL_CALLS = new Set(['tool_calls', 'tool_use', 'function_call'])

/**
 * @param {object} input
 * @param {boolean} input.streamEnded   `[DONE]` was seen
 * @param {string|undefined} input.finishReason upstream's own reason
 * @param {boolean} input.argsTruncated any tool call's arguments are incomplete
 * @param {number} input.orphanCalls    tool-call fragments that never got a name
 * @param {number} input.blockCount     blocks that were actually delivered
 * @param {boolean} input.hasTools      a tool call was announced
 * @param {string} [install]
 * @returns {{ kind: string, failure?: { message: string, code: string }, note?: string }}
 */
export function classifyEnding({ streamEnded, finishReason, argsTruncated, orphanCalls, blockCount, hasTools }, provider) {
  const withProvider = (message, code) => ({ kind: 'error', failure: { message: `${provider}: ${message}`, code } })
  const raw = finishReason ?? '(无)'

  if (orphanCalls > 0) {
    return withProvider(`上游发送了工具调用但没有给出工具名（finish_reason=${raw}；可重试的传输错误）`, 'TRANSPORT')
  }
  if (!streamEnded && finishReason === undefined) {
    return { kind: 'error', failure: { message: `${provider}: 上游没有给出结束原因就断开了响应`, code: 'TRANSPORT' }, note: 'cut' }
  }
  if (argsTruncated && !streamEnded) {
    return { kind: 'error', failure: { message: `${provider}: 工具调用的参数在传输中被截断`, code: 'TRANSPORT' }, note: 'args-cut' }
  }
  if (argsTruncated) {
    return { kind: 'max-tokens', note: 'args-budget' }
  }
  if (REFUSALS.has(finishReason)) {
    return withProvider(`上游拒绝或按内容策略过滤了本次回答（finish_reason=${finishReason}），请换个说法或换个模型`, 'INVALID_REQUEST')
  }
  if (finishReason === 'error') {
    return withProvider('上游在回答中途返回了错误（finish_reason=error；可重试的传输错误）', 'TRANSPORT')
  }
  if (blockCount === 0) {
    if (BUDGETS.has(finishReason)) return { kind: 'max-tokens', note: 'empty-budget' }
    return { kind: 'error', failure: { message: '模型返回了空响应', code: 'EMPTY_RESPONSE' } }
  }
  // A tool-call `finish_reason` counts even when nothing was announced: the model asked
  // for a call, and reporting `stop` would end the turn as if it had finished.
  if (hasTools || TOOL_CALLS.has(finishReason)) return { kind: 'tool-calls' }
  if (BUDGETS.has(finishReason)) return { kind: 'max-tokens', note: 'budget' }
  return { kind: 'stop', note: finishReason === undefined ? 'done-without-reason' : undefined }
}

/** Whether this `finish_reason` is one of the tool-call spellings. */
export function isToolCallReason(finishReason) {
  return TOOL_CALLS.has(finishReason)
}
