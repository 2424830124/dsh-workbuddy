/**
 * Server-sent-events transport.
 *
 * Only the framing lives here: bytes → `data:` payloads, with `[DONE]` reported as its
 * own sentinel and the reader always cancelled and released. What a payload *means*
 * (deltas, tool-call fragments, usage, finish reasons) belongs to the adapter, which is
 * why this file has no opinion about any of it.
 */

/** The last event of a well-formed stream. */
export const SSE_DONE = Symbol('sse-done')

/**
 * Yield `data:` payload strings until `[DONE]`, the end of the body, or a socket error.
 *
 * `state` is updated as bytes arrive so the caller can still describe a cut stream: how
 * much arrived, and when the last chunk landed.
 *
 * @param {Response} response
 * @param {{ receivedBytes: number, lastDataAt: number }} state
 * @returns {AsyncGenerator<string | typeof SSE_DONE>}
 */
export async function* readSse(response, state) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) return
      state.receivedBytes += result.value?.byteLength ?? 0
      state.lastDataAt = Date.now()
      buffer += decoder.decode(result.value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          yield SSE_DONE
          return
        }
        yield payload
      }
    }
  } finally {
    // Cancel before releasing: when the caller stopped at `[DONE]` the rest of the body
    // was never read, and releasing the lock alone leaves that connection open.
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
