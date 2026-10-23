/**
 * The harness→wire conversion, tested directly.
 *
 * Everything here is the shape of a request, not the streaming around it: a tool result
 * is its own message, a call survives only with its result, and `developer` reads as
 * system. The adapter's suite covers the same ground through `buildBody`; this one keeps
 * the contract readable when something breaks.
 */
import assert from 'node:assert/strict'

const { toWireMessages, toolResultCallId, resolveToolPairing, contentToText } = await import('../../src/wire.js')

// --- a result message answers its call -------------------------------------
const toolMessage = { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text: 'done' }] }
assert.equal(toolResultCallId(toolMessage), 'call_1')
assert.equal(toolResultCallId({ role: 'tool', toolCallId: 'legacy' }), 'legacy', 'the older field is read too')
assert.equal(toolResultCallId({ role: 'user' }), undefined, 'a user message is not a result')

const transcript = [
  { role: 'user', content: [{ type: 'text', text: '改一下' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'write', arguments: '{"file_path":"a"}' }] },
  toolMessage
]
const pairing = resolveToolPairing(transcript)
assert.ok(pairing.keepCallIds.has('call_1'), 'a call with a matching result is kept')
assert.ok(pairing.keepResultIds.has('call_1'))

const wire = toWireMessages(transcript, undefined)
assert.deepEqual(wire.map((message) => message.role), ['user', 'assistant', 'tool'])
assert.equal(wire[1].tool_calls[0].id, 'call_1')
assert.equal(wire[2].tool_call_id, 'call_1', 'the result keeps the id it answers')
assert.equal(wire[2].content, 'done')
assert.ok(!wire.some((message) => message.role === 'user' && message.content === 'done'), 'the result is not a user message')

// --- an unanswered call is dropped, together with its result --------------
const orphan = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'read', arguments: '{}' }] }
]
const orphanWire = toWireMessages(orphan, undefined)
assert.ok(!orphanWire.some((message) => Array.isArray(message.tool_calls)), 'a call without a result is dropped')

// --- legacy nested results still pair ------------------------------------
const legacy = [
  { role: 'assistant', content: [{ type: 'tool-call', id: 'call_3', name: 'write', arguments: '{}' }] },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_3', content: [{ type: 'text', text: 'ok' }] }] }
]
const legacyWire = toWireMessages(legacy, undefined)
assert.ok(legacyWire.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_3'))
assert.ok(legacyWire.some((message) => message.role === 'tool' && message.tool_call_id === 'call_3'))

// --- roles ---------------------------------------------------------------
const roles = toWireMessages([
  { role: 'system', content: [{ type: 'text', text: 'sys' }] },
  { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
  { role: 'user', content: 'plain string' }
], undefined)
assert.deepEqual(roles.map((message) => message.role), ['system', 'system', 'user'])
assert.equal(roles[1].content, 'dev', 'a developer message reads as system')
assert.equal(roles[2].content, 'plain string')

// --- assistant replay ----------------------------------------------------
const replay = toWireMessages([
  { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '答案' }] }
], undefined)
assert.equal(replay[0].reasoning_content, '想一想', 'reasoning is replayed as reasoning_content')
assert.equal(replay[0].content, '答案')

// --- helpers -------------------------------------------------------------
assert.equal(contentToText('abc'), 'abc')
assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
assert.equal(contentToText(undefined), '')

console.log('wire.mjs: OK — tool-role results, pairing, legacy results, roles, and replay verified')
