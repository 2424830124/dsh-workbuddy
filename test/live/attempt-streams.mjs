/**
 * What did each attempt actually stream, and how did it end?
 *
 * `assistant/attempt` stores the whole stream, so the finish reason, the usage and
 * whether any tool-call delta arrived are all recoverable — which is how an
 * upstream early stop is told apart from a frame the plugin dropped.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const projectDir = join(home, 'sessions', '--E-Projects-dsh-workbuddy--')
const resolved = readdirSync(projectDir).find((name) => name.includes(process.argv[2] ?? '6eb8dacf'))
const dir = join(projectDir, resolved)
const file = readdirSync(dir).find((name) => name.endsWith('.zstd'))
const buffer = readFileSync(join(dir, file))
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const parts = []
let at = buffer.indexOf(magic)
while (at >= 0) {
  try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn tail */ }
  at = buffer.indexOf(magic, at + 4)
}
const events = Buffer.concat(parts).toString('utf8').split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)

const attempts = events.filter((event) => event.type === 'assistant/attempt')
console.log(`会话 ${resolved} — attempt ${attempts.length} 个\n`)

const rows = attempts.map((event) => {
  const data = event.data ?? {}
  const chunks = Array.isArray(data.stream) ? data.stream : []
  const kinds = new Map()
  let toolDelta = 0
  let reasoning = 0
  let text = 0
  let finish
  let usage
  for (const entry of chunks) {
    const chunk = entry.chunk ?? entry
    const type = chunk?.type ?? '?'
    kinds.set(type, (kinds.get(type) ?? 0) + 1)
    if (type === 'text-delta' || type === 'text') text += String(chunk.text ?? chunk.delta ?? '').length
    if (type === 'reasoning-delta' || type === 'reasoning') reasoning += String(chunk.text ?? chunk.delta ?? '').length
    if (type === 'tool-call-delta' || type === 'tool-call') toolDelta += 1
    if (type === 'finish') finish = chunk.reason ?? chunk
    if (type === 'usage') usage = chunk.usage ?? chunk
  }
  return {
    turn: data.turn,
    step: data.step,
    model: data.meta?.model ?? data.model ?? '',
    provider: data.meta?.provider ?? data.provider ?? '',
    kinds: [...kinds].map(([type, count]) => `${type}×${count}`).join(' '),
    text,
    reasoning,
    toolDelta,
    finish: finish === undefined ? '(无 finish 帧)' : JSON.stringify(finish).slice(0, 160),
    usage: usage === undefined ? '' : JSON.stringify(usage).slice(0, 120)
  }
})

console.log('最后 18 个 attempt:')
for (const row of rows.slice(-18)) {
  console.log(`  turn ${row.turn} step ${row.step}  ${row.provider || '?'}/${row.model || '?'}`)
  console.log(`     chunks: ${row.kinds}`)
  console.log(`     text=${row.text} reasoning=${row.reasoning} toolChunks=${row.toolDelta}`)
  console.log(`     finish: ${row.finish}`)
  if (row.usage.length > 0) console.log(`     usage: ${row.usage}`)
}

const finishKinds = new Map()
for (const row of rows) {
  const kind = /"kind":"([a-z-]+)"/.exec(row.finish)?.[1] ?? row.finish
  finishKinds.set(kind, (finishKinds.get(kind) ?? 0) + 1)
}
console.log('\nfinish 类型分布:', [...finishKinds].map(([kind, count]) => `${kind}=${count}`).join('  '))

const noFinish = rows.filter((row) => row.finish === '(无 finish 帧)')
console.log(`没有 finish 帧的 attempt: ${noFinish.length}`)
for (const row of noFinish.slice(-6)) console.log(`   turn ${row.turn} step ${row.step} chunks: ${row.kinds}`)
