/** Find a message by its text and dump the events around it. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sessionsRoot = join(home, 'sessions')
const needle = process.argv[2] ?? 'bundle 是否被移除'
const wanted = process.argv[3] ?? '6eb8dacf'

let dir
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  try { if (!readdirSync(projectDir).some((name) => name.includes(wanted))) continue } catch { continue }
  dir = join(projectDir, readdirSync(projectDir).find((name) => name.includes(wanted)))
  break
}
if (dir === undefined) { console.log('没有匹配的会话'); process.exit(1) }

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const events = []
for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.zstd')).sort()) {
  const buffer = readFileSync(join(dir, name))
  const parts = []
  let at = buffer.indexOf(magic)
  while (at >= 0) {
    try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn */ }
    at = buffer.indexOf(magic, at + 4)
  }
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* torn */ }
  }
}
events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
console.log(`会话 ${dir.split(/[\\/]/).pop()} — ${events.length} 个事件`)

const matches = events
  .map((event, index) => ({ event, index }))
  .filter(({ event }) => JSON.stringify(event.data ?? {}).includes(needle))
console.log(`包含 “${needle}” 的事件: ${matches.length}`)
for (const { event, index } of matches.slice(-2)) {
  console.log(`\n=== 命中 seq ${event.seq} type ${event.type} @ ${new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })}`)
  const from = Math.max(0, index - 6)
  const to = Math.min(events.length, index + 9)
  for (let cursor = from; cursor < to; cursor += 1) {
    const entry = events[cursor]
    const data = entry.data ?? {}
    const brief = []
    for (const key of ['turn', 'step', 'reason', 'status', 'interrupted', 'name', 'provider', 'model', 'finishReason']) {
      if (data[key] !== undefined) brief.push(`${key}=${JSON.stringify(data[key]).slice(0, 60)}`)
    }
    const content = data.message?.content ?? data.content
    if (typeof content === 'string' && content.length > 0) brief.push(`text=${JSON.stringify(content.slice(0, 70))}`)
    if (Array.isArray(content)) brief.push(`blocks=[${content.map((block) => block?.type).join(',')}]`)
    if (Array.isArray(data.stream)) brief.push(`stream=${data.stream.length} 帧`)
    console.log(`${cursor === index ? '→' : ' '} seq ${entry.seq} ${entry.type}  ${brief.join('  ')}`)
  }
}

// The request that preceded the hit names the provider and the output budget.
const hit = matches.at(-1)
if (hit !== undefined) {
  let config = {}
  for (const event of events) {
    if (event.seq > hit.event.seq) break
    if (event.type === 'request/header') config = event.data?.header?.config ?? config
  }
  console.log('\n该步骤所用请求:', JSON.stringify(config))
  const after = events.filter((event) => event.seq > hit.event.seq).slice(0, 4)
  console.log('之后事件:', after.map((event) => `${event.type}(${JSON.stringify(event.data ?? {}).slice(0, 80)})`).join(' → '))
}
