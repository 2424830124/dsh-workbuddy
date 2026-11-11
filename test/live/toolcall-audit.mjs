/**
 * Did the harness receive the tool call upstream announced?
 *
 * An attempt whose finish is `tool-calls` but which delivered no tool-call chunk
 * is the fingerprint of a call being dropped during assembly (a name that never
 * arrived, an index that did not line up). Nothing else in the session says so:
 * the harness just sees a finished step with no call.
 *
 * Run: `node test/live/toolcall-audit.mjs [sessionIdPrefix] [attempts]`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sessionsRoot = join(home, 'sessions')
const wanted = process.argv[2] ?? '6eb8dacf'
const limit = Number(process.argv[3] ?? 8)

let dir
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  let stat
  try { stat = statSync(projectDir) } catch { continue }
  if (!stat.isDirectory()) continue
  const found = readdirSync(projectDir).find((name) => name.includes(wanted))
  if (found !== undefined) { dir = join(projectDir, found); break }
}
if (dir === undefined) { console.log('没有匹配的会话:', wanted); process.exit(1) }
console.log('会话:', dir.split(/[\\/]/).pop())

// A session can hold more than one log generation (`session.v4.jsonl.zstd`,
// `session.v5…` after a migration), and each is a framed zstd container, so every
// generation is decoded and the events are ordered by seq.
const decodeAll = (directory) => {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const out = []
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.zstd')).sort()) {
    const buffer = readFileSync(join(directory, name))
    const parts = []
    let at = buffer.indexOf(magic)
    while (at >= 0) {
      try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn tail */ }
      at = buffer.indexOf(magic, at + 4)
    }
    for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try { out.push(JSON.parse(line)) } catch { /* torn */ }
    }
  }
  out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return out
}
const events = decodeAll(dir)

const headers = events.filter((event) => event.type === 'request/header')
const configOf = (seq) => {
  let found = {}
  for (const header of headers) { if (header.seq > seq) break; found = header.data?.header?.config ?? {} }
  return found
}

const attempts = events.filter((event) => event.type === 'assistant/attempt')
console.log(`attempt ${attempts.length} 个\n`)
console.log('最后 ' + limit + ' 次请求：')
for (const event of attempts.slice(-limit)) {
  const config = configOf(event.seq)
  const chunks = Array.isArray(event.data?.stream) ? event.data.stream : []
  let finish
  let usage
  let text = ''
  let reasoning = ''
  let toolDeltas = 0
  let toolNames = []
  for (const entry of chunks) {
    const chunk = entry.chunk ?? entry
    if (chunk?.type === 'finish') finish = chunk.reason ?? chunk
    if (chunk?.type === 'usage') usage = chunk.usage ?? chunk
    if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
    if (chunk?.type === 'reasoning-delta') reasoning += String(chunk.text ?? '')
    if (chunk?.type === 'tool-call-delta') { toolDeltas += 1; if (chunk.name !== undefined) toolNames.push(chunk.name) }
  }
  // What the session recorded as a call, and what followed.
  const nextEvents = events.filter((entry) => entry.seq > event.seq).slice(0, 6).map((entry) => entry.type)
  const stamp = new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })
  const suspicious = finish?.kind === 'tool-calls' && toolDeltas === 0
  console.log(`\n${stamp} turn ${event.data?.turn} step ${event.data?.step}  ${config.provider ?? '?'}/${config.model ?? '?'}`)
  console.log(`  finish=${finish?.kind ?? '(无)'}${finish?.failure !== undefined ? ` (${finish.failure.code})` : ''}  工具分片=${toolDeltas}${toolNames.length > 0 ? ` 名称=${[...new Set(toolNames)].join('/')}` : ''}${suspicious ? '   ← 上游说 tool-calls，但没有任何工具分片交付' : ''}`)
  console.log(`  usage: output=${usage?.outputTokens ?? '?'} reasoning=${usage?.reasoningTokens ?? '?'} | 思考字符=${reasoning.length} 正文字符=${text.length}`)
  console.log(`  正文: ${JSON.stringify(text.slice(0, 90))}`)
  console.log(`  之后的事件: ${nextEvents.join(' → ')}`)
}

// Ground truth: which tool calls the session actually recorded.
const calls = events.filter((event) => event.type === 'tool/call')
console.log(`\n会话记录的 tool/call 共 ${calls.length} 个；最后 5 个:`)
for (const call of calls.slice(-5)) {
  console.log(`  seq ${call.seq} ${call.data?.name ?? '?'} (turn ${call.data?.turn ?? '?'})`)
}
