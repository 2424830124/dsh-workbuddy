/**
 * What did upstream actually say on the last steps? Reads the stored finish chunks.
 *
 * Since the finish chunk carries a `response` diagnostics block, the session log holds
 * upstream's own `stopReason` for every step — no heuristic, no guessing.
 *
 * Run: `node test/live/last-finishes.mjs [sessionPrefix] [steps]`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sessionsRoot = join(home, 'sessions')
const prefix = process.argv[2]
const limit = Number(process.argv[3] ?? 12)
// Optional project filter, e.g. "dsh-model-picker" — the newest session of *that*
// workspace is usually the one being investigated.
const projectFilter = process.argv[4]

const candidates = []
for (const project of readdirSync(sessionsRoot)) {
  if (projectFilter !== undefined && !project.includes(projectFilter)) continue
  const projectDir = join(sessionsRoot, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  for (const name of names) {
    const dir = join(projectDir, name)
    let log
    try { log = readdirSync(dir).find((entry) => entry.endsWith('.zstd')) } catch { continue }
    if (log === undefined) continue
    candidates.push({ dir, name, at: statSync(join(dir, log)).mtimeMs })
  }
}
candidates.sort((a, b) => b.at - a.at)
const target = prefix === undefined ? candidates[0] : candidates.find((entry) => entry.name.includes(prefix))
if (target === undefined) { console.log('没有匹配的会话'); process.exit(1) }
console.log(`会话 ${target.name}（最后写入 ${new Date(target.at).toLocaleString('zh-CN', { hour12: false })}）`)

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const events = []
for (const name of readdirSync(target.dir).filter((entry) => entry.endsWith('.zstd')).sort()) {
  const buffer = readFileSync(join(target.dir, name))
  const parts = []
  let at = buffer.indexOf(magic)
  while (at >= 0) {
    try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn tail */ }
    at = buffer.indexOf(magic, at + 4)
  }
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* torn */ }
  }
}
events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

// Each assistant/message holds the step's frames; the finish frame carries `response`.
const rows = []
for (const event of events) {
  if (event.type !== 'assistant/message') continue
  const frames = Array.isArray(event.data?.stream) ? event.data.stream : []
  let finish
  let text = ''
  let reasoning = 0
  let toolCalls = 0
  for (const entry of frames) {
    const chunk = entry.chunk ?? entry
    if (chunk?.type === 'finish') finish = chunk
    if (chunk?.type === 'text-chunks') text += (chunk.texts ?? []).join('')
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text = chunk.block.text ?? text
    if (chunk?.type === 'reasoning-chunks') reasoning += (chunk.texts ?? []).join('').length
    if (chunk?.type === 'tool-call-chunks') toolCalls += 1
  }
  rows.push({
    turn: event.data?.turn,
    step: event.data?.step,
    time: event.time,
    kind: finish?.reason?.kind ?? '(无)',
    raw: finish?.response?.stopReason ?? finish?.reason?.failure?.code ?? '(无)',
    model: finish?.response?.model ?? '?',
    provider: finish?.response?.provider ?? '?',
    output: finish?.response?.outputTokens,
    text,
    reasoning,
    toolCalls
  })
}

console.log(`\n最后 ${limit} 步：`)
for (const row of rows.slice(-limit)) {
  const stamp = new Date(row.time).toLocaleTimeString('zh-CN', { hour12: false })
  const flag = row.kind === 'stop' && row.toolCalls === 0 ? '  ← 没有工具调用' : ''
  console.log(`${stamp} turn ${row.turn} step ${row.step}  ${row.provider}/${row.model}`)
  console.log(`   kind=${row.kind}  upstream.stopReason=${row.raw}  output=${row.output ?? '?'}  思考=${row.reasoning}字 正文=${row.text.length}字 工具分片=${row.toolCalls}${flag}`)
  if (row.text.length > 0) console.log(`   正文：「${row.text.trim().slice(0, 60)}」`)
}

const stops = rows.filter((row) => row.kind === 'stop' && row.toolCalls === 0)
console.log(`\n以 stop 结束、无工具调用的步骤：${stops.length} / ${rows.length}`)
const rawCounts = new Map()
for (const row of rows) rawCounts.set(row.raw, (rawCounts.get(row.raw) ?? 0) + 1)
console.log('上游 stopReason 分布:', [...rawCounts].map(([key, count]) => `${key}=${count}`).join('  '))
