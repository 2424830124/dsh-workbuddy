/**
 * Read a session log whose final frame is still being written.
 *
 * The session artifact is a framed zstd container flushed in batches, so the newest
 * frame is often incomplete and a plain decompress throws. The official reader passes
 * `finishFlush: ZSTD_e_flush` for exactly this; the same option is used here, and then
 * the tail events are reported.
 *
 * Run: `node test/live/session-tail-live.mjs [sessionPrefix] [steps] [projectFilter]`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { constants, zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const root = join(home, 'sessions')
const prefix = process.argv[2]
const steps = Number(process.argv[3] ?? 10)
const projectFilter = process.argv[4]

const candidates = []
for (const project of readdirSync(root)) {
  if (projectFilter !== undefined && !project.includes(projectFilter)) continue
  const projectDir = join(root, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  for (const name of names) {
    const dir = join(projectDir, name)
    let files
    try { files = readdirSync(dir).filter((entry) => entry.endsWith('.zstd')) } catch { continue }
    for (const file of files) candidates.push({ dir, file, name, at: statSync(join(dir, file)).mtimeMs })
  }
}
candidates.sort((a, b) => b.at - a.at)
const target = prefix === undefined ? candidates[0] : candidates.find((entry) => entry.name.includes(prefix))
if (target === undefined) { console.log('没有匹配的会话'); process.exit(1) }
console.log(`会话 ${target.name}（${target.file}，最后写入 ${new Date(target.at).toLocaleString('zh-CN', { hour12: false })}）`)

const buffer = readFileSync(join(target.dir, target.file))
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let at = buffer.indexOf(magic)
while (at >= 0) { offsets.push(at); at = buffer.indexOf(magic, at + 4) }

let complete = 0
let torn = 0
const parts = []
for (const offset of offsets) {
  try {
    parts.push(zstdDecompressSync(buffer.subarray(offset)))
    complete += 1
    continue
  } catch { /* fall through to the tolerant attempt */ }
  try {
    // `finishFlush: ZSTD_e_flush` keeps whatever decoded before the truncation.
    parts.push(zstdDecompressSync(buffer.subarray(offset), { finishFlush: constants.ZSTD_e_flush }))
    torn += 1
  } catch { torn += 1 }
}
console.log(`帧 ${offsets.length} 个：完整 ${complete}，残帧 ${torn}（残帧用 flush 模式尽量解出）`)

const events = Buffer.concat(parts).toString('utf8').split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)
events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
console.log(`事件 ${events.length} 个，最新 ${events.at(-1)?.type} @ ${new Date(events.at(-1)?.time ?? 0).toLocaleTimeString('zh-CN', { hour12: false })}`)

const rows = []
for (const event of events) {
  if (event.type !== 'assistant/message') continue
  const frames = (event.data?.stream ?? []).map((entry) => entry.chunk ?? entry)
  const finish = frames.find((chunk) => chunk?.type === 'finish')
  let text = ''
  let reasoning = 0
  let toolCalls = 0
  for (const chunk of frames) {
    if (chunk?.type === 'text-chunks') text += (chunk.texts ?? []).join('')
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text') text = chunk.block.text ?? text
    if (chunk?.type === 'reasoning-chunks') reasoning += (chunk.texts ?? []).join('').length
    if (chunk?.type === 'tool-call-chunks' || (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call')) toolCalls += 1
  }
  rows.push({
    turn: event.data?.turn,
    step: event.data?.step,
    kind: finish?.reason?.kind ?? '(无)',
    raw: finish?.response?.stopReason ?? finish?.replayState?.response?.stopReason ?? '(无)',
    model: finish?.response?.model ?? finish?.replayState?.response?.model ?? '?',
    output: finish?.response?.outputTokens ?? finish?.replayState?.response?.outputTokens,
    text,
    reasoning,
    toolCalls,
    time: event.time
  })
}

console.log(`\n最后 ${steps} 步：`)
for (const row of rows.slice(-steps)) {
  const stamp = new Date(row.time).toLocaleTimeString('zh-CN', { hour12: false })
  const flag = row.kind === 'stop' && row.toolCalls === 0 ? '   ← stop 且没有工具调用' : ''
  console.log(`${stamp} turn ${row.turn} step ${row.step}  ${row.model}`)
  console.log(`   kind=${row.kind}  upstream.stopReason=${row.raw}  output=${row.output ?? '?'}  思考=${row.reasoning}字 正文=${row.text.length}字 工具=${row.toolCalls}${flag}`)
  if (row.text.length > 0) console.log(`   正文：「${row.text.trim().slice(0, 70)}」`)
}
