/**
 * Harness messages → OpenAI-compatible wire messages.
 *
 * Split out of the adapter so the conversion can be read and tested on its own: every
 * bug this file has had (tool results promoted to user messages, calls dropped when
 * their result was in the other shape) lived here, and the adapter's streaming code
 * made them hard to see.
 */

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => typeof block === 'object' && block !== null && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
}

function normalizeToolArguments(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return '{}'
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? trimmed : '{}'
  } catch {
    return '{}'
  }
}

const hasUsableToolName = (name) => typeof name === 'string' && name.trim().length > 0

/** Keep only tool call/result pairs that are complete on both sides. */
/**
 * The call id a result message answers.
 *
 * The harness answers a call with a message of its own: `{ role: 'tool', source: {
 * kind: 'tool', callId } }`. Older transcripts put the result inside the content
 * blocks as `{ type: 'tool-result', toolCallId }`; both are read here so neither
 * shape loses its pairing.
 */
function toolResultCallId(message) {
  if (message?.role !== 'tool') return undefined
  const id = message.source?.callId ?? message.toolCallId ?? message.tool_call_id
  return id === undefined || id === null ? undefined : String(id)
}

function resolveToolPairing(messages) {
  const allResultIds = new Set()
  for (const message of messages) {
    const standalone = toolResultCallId(message)
    if (standalone !== undefined) { allResultIds.add(standalone); continue }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'tool-result') allResultIds.add(String(block.toolCallId))
    }
  }
  const keepCallIds = new Set()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const calls = (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === 'tool-call' && hasUsableToolName(block.name))
    if (calls.length > 0 && calls.every((block) => allResultIds.has(String(block.id)))) {
      for (const block of calls) keepCallIds.add(String(block.id))
    }
  }
  return { keepCallIds, keepResultIds: new Set(keepCallIds) }
}

function userContentParts(content, imageUrls) {
  const parts = []
  let hasImage = false
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'text') {
      parts.push({ type: 'text', text: String(block.text ?? '') })
      continue
    }
    if (block.type === 'image') {
      const attachmentId = block.attachment?.attachmentId
      const url = attachmentId === undefined ? undefined : imageUrls?.get(String(attachmentId))
      parts.push(url === undefined ? { type: 'text', text: '[image unavailable]' } : { type: 'image_url', image_url: { url } })
      hasImage = true
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls)
      if (inner !== undefined) {
        parts.push(...inner)
        hasImage = true
      } else {
        parts.push({ type: 'text', text: contentToText(block.content) })
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined
}

/**
 * Convert harness messages into the OpenAI-compatible wire array, matching the
 * shape the official clients send (including `reasoning_content` replay on
 * assistant turns, which WorkBuddy accepts).
 */
function toWireMessages(messages, imageUrls) {
  const wire = []
  let pendingToolImages = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages] })
    pendingToolImages = []
  }
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block) => block?.type === 'tool-call' && keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function',
          function: { name: String(block.name), arguments: normalizeToolArguments(block.arguments) }
        }))
      const reasoning = content.filter((block) => block?.type === 'reasoning').map((block) => String(block.text ?? '')).join('')
      const textContent = contentToText(content)
      if (textContent.trim().length === 0 && toolCalls.length === 0) continue
      flushToolImages()
      wire.push({
        role: 'assistant',
        content: textContent.length === 0 && toolCalls.length > 0 ? null : textContent,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      })
      continue
    }
    if (message.role === 'system' || message.role === 'developer') {
      flushToolImages()
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // A tool result arrives as a message of its own (see `toolResultCallId`); it must
    // stay a `tool` message, or the model loses which call it answers.
    const resultCallId = toolResultCallId(message)
    if (resultCallId !== undefined) {
      if (!keepResultIds.has(resultCallId)) continue
      let resultText = '(no output)'
      if (imageUrls !== undefined && Array.isArray(message.content)) {
        const resultParts = userContentParts(message.content, imageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('')
          if (joined.length > 0) resultText = joined
        } else {
          resultText = contentToText(message.content) || '(no output)'
        }
      } else {
        resultText = contentToText(message.content) || '(no output)'
      }
      wire.push({ role: 'tool', tool_call_id: resultCallId, content: resultText })
      continue
    }

    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block) => block?.type === 'tool-result')
    const regular = content.filter((block) => block?.type !== 'tool-result')
    const text = contentToText(message.content)
    const parts = userContentParts(regular, imageUrls)
    if (parts !== undefined) {
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.trim().length > 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue
      let resultText = '(no output)'
      if (imageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('')
          if (joined.length > 0) resultText = joined
        } else {
          resultText = contentToText(result.content) || '(no output)'
        }
      } else {
        resultText = contentToText(result.content) || '(no output)'
      }
      wire.push({ role: 'tool', tool_call_id: String(result.toolCallId), content: resultText })
    }
  }
  flushToolImages()
  return wire
}

export {
  contentToText,
  hasUsableToolName,
  normalizeToolArguments,
  resolveToolPairing,
  toolResultCallId,
  toWireMessages
}
