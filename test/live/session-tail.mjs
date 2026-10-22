/**
 * Dev probe: read one session's stored event log.
 *
 * Answers "was that an upstream early finish, or a frame the plugin dropped?"
 * without opening the GUI: the log holds what the adapter actually delivered,
 * including each turn's finish reason and tool calls.
 *
 * The log is a framed zstd container (append-and-recover batches), and Node's
 * decompressor stops at the first frame, so the frames are located by their magic
 * and expanded one by one.
 *
 * Run: `node test/live/session-tail.mjs <sessionIdOrPrefix> [eventCount]`
 *      `node test/live/session-tail.mjs --list`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const projectDir = join(home, 'sessions', '--E-Projects-dsh-workbuddy--')

/** Offset of every zstd frame magic (0xFD2FB528, little-endian on disk). */
function frameOffsets(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let index = buffer.indexOf(magic)
  while (index >= 0) {
    offsets.push(index)
    index = buffer.indexOf(magic, index + 4)
  }
  return offsets
}

function decodeFrames(buffer) {
  const parts = []
  for (const offset of frameOffsets(buffer)) {
    try {
      const decoded = zstdDecompressSync(buffer.subarray(offset))
      if (decoded.length > 0) parts.push(decoded)
    } catch { /* not a frame start, or a torn tail */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

const sessions = readdirSync(projectDir).filter((name) => {
  try { return statSync(join(projectDir, name)).isDirectory() } catch { return false }
})
if (process.argv[2] === undefined || process.argv[2] === '--list') {
  for (const name of sessions) {
    const dir = join(projectDir, name)
    const size = readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0)
    console.log(`${statSync(dir).mtime.toISOString().slice(0, 16)}  ${String(Math.round(size / 1024)).padStart(6)}kB  ${name}`)
  }
  process.exit(0)
}

const wanted = process.argv[2]
const tailCount = Number(process.argv[3] ?? 40)
const id = sessions.find((name) => name === wanted || name.includes(wanted))
if (id === undefined) { console.log(`没有匹配 “${wanted}” 的会话`); process.exit(1) }
const dir = join(projectDir, id)

const files = readdirSync(dir).map((file) => ({ file, full: join(dir, file), size: statSync(join(dir, file)).size }))
console.log(`会话 ${id}`)
console.log('文件:', files.map((entry) => `${entry.file}(${Math.round(entry.size / 1024)}kB)`).join('  '))

const log = files.filter((entry) => /\.(jsonl|json)(\.zstd)?$/.test(entry.file)).sort((a, b) => b.size - a.size)[0]
const buffer = readFileSync(log.full)
const text = log.file.endsWith('.zstd') ? decodeFrames(buffer) : buffer.toString('utf8')
const lines = text.split('\n').filter((line) => line.trim().length > 0)
const events = []
for (const line of lines) {
  try { events.push(JSON.parse(line)) } catch { /* a torn tail line */ }
}
console.log(`解压后 ${Math.round(text.length / 1024)} kB，事件数 ${events.length}（${log.file}）`)
if (events.length === 0) process.exit(0)

const types = new Map()
for (const event of events) {
  const type = event.type ?? event.kind ?? '?'
  types.set(type, (types.get(type) ?? 0) + 1)
}
console.log('\n事件类型分布:')
for (const [type, count] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 24)) console.log(`  ${String(count).padStart(5)}  ${type}`)

const keys = new Set()
for (const event of events) {
  const type = String(event.type ?? '')
  if (!/assistant|message|turn|step|finish|llm|tool/i.test(type)) continue
  for (const key of Object.keys(event)) keys.add(key)
  for (const key of Object.keys(event.data ?? {})) keys.add(`data.${key}`)
}
console.log('\n相关事件的键名:', [...keys].sort().join(', '))

const brief = (value, limit = 90) => {
  if (value === undefined || value === null) return ''
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  return rendered.length > limit ? `${rendered.slice(0, limit)}…` : rendered
}

console.log(`\n最后 ${tailCount} 个事件:`)
for (const event of events.slice(-tailCount)) {
  try {
    const type = event.type ?? event.kind ?? '?'
    const data = event.data ?? event.payload ?? event
    const parts = []
    for (const [label, value] of [
      ['role', data.role],
      ['finish', data.finishReason ?? data.reason ?? data.stopReason ?? data.status],
      ['model', data.model],
      ['provider', data.provider],
      ['error', data.error ?? data.failure],
      ['reasoning', data.reasoning ?? data.reasoningContent]
    ]) if (value !== undefined && value !== null) parts.push(`${label}=${brief(value, 40)}`)
    const content = data.content
    if (Array.isArray(content)) parts.push(`content=[${content.map((block) => block?.type ?? '?').join(',')}]`)
    else if (typeof content === 'string' && content.length > 0) parts.push(`text=${content.length}字:${brief(content, 40)}`)
    const toolCalls = data.toolCalls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) parts.push(`toolCalls=${toolCalls.map((call) => call?.name ?? call?.function?.name ?? '?').join('/')}`)
    console.log(`  ${type}  ${parts.join('  ')}`)
  } catch (error) {
    console.log(`  (无法摘要 ${event?.type ?? '?'}: ${error.message})`)
  }
}

// Finish reasons, retries, and interrupted turns: the three signals that tell an
// upstream early stop from a plugin-side failure.
const counts = (predicate, key) => {
  const map = new Map()
  for (const event of events) {
    if (!predicate(event)) continue
    const value = key(event)
    if (value === undefined) continue
    map.set(value, (map.get(value) ?? 0) + 1)
  }
  return [...map].sort((a, b) => b[1] - a[1])
}
console.log('\nassistant/message 的 finish/reason 分布:')
for (const [value, count] of counts((event) => event.type === 'assistant/message', (event) => String(event.data?.finishReason ?? event.data?.reason ?? '(无)'))) {
  console.log(`  ${String(count).padStart(5)}  ${value}`)
}
console.log('\nllm/retry 的原因分布:')
for (const [value, count] of counts((event) => event.type === 'llm/retry', (event) => brief(event.data?.reason ?? event.data?.error ?? '(无)', 70))) {
  console.log(`  ${String(count).padStart(5)}  ${value}`)
}
console.log('\nturn/end 的字段样本:')
for (const event of events.filter((entry) => entry.type === 'turn/end').slice(-3)) console.log(' ', JSON.stringify(event.data ?? {}).slice(0, 300))
