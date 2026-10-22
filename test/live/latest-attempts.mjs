/** Audit the attempts of whichever session was written most recently, in any project. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sessionsRoot = join(home, 'sessions')
const since = Number(process.argv[2] ?? (Date.now() - 30 * 60_000))

const candidates = []
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  let projectStat
  try { projectStat = statSync(projectDir) } catch { continue }
  if (!projectStat.isDirectory()) continue
  for (const name of readdirSync(projectDir)) {
    const dir = join(projectDir, name)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    // The log file is flushed in batches, so the *file* timestamp — not the
    // directory's — says which session is actually being written right now.
    const log = readdirSync(dir).find((entry) => entry.endsWith('.zstd'))
    if (log === undefined) continue
    candidates.push({ project, name, dir, at: statSync(join(dir, log)).mtimeMs })
  }
}
candidates.sort((a, b) => b.at - a.at)
console.log(`最近写入的 5 个会话（从 ${new Date(since).toLocaleString('zh-CN', { hour12: false })} 起统计）:`)
for (const candidate of candidates.slice(0, 5)) {
  console.log(`  ${new Date(candidate.at).toLocaleString('zh-CN', { hour12: false })}  ${candidate.project}  ${candidate.name}`)
}

const decode = (dir) => {
  const file = readdirSync(dir).find((entry) => entry.endsWith('.zstd'))
  if (file === undefined) return []
  const buffer = readFileSync(join(dir, file))
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts = []
  let at = buffer.indexOf(magic)
  while (at >= 0) {
    try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn */ }
    at = buffer.indexOf(magic, at + 4)
  }
  return Buffer.concat(parts).toString('utf8').split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

for (const candidate of candidates.slice(0, 3)) {
  const events = decode(candidate.dir)
  const headers = events.filter((event) => event.type === 'request/header')
  const configOf = (seq) => {
    let found = {}
    for (const header of headers) { if (header.seq > seq) break; found = header.data?.header?.config ?? {} }
    return found
  }
  const attempts = events.filter((event) => event.type === 'assistant/attempt' && event.time >= since)
  if (attempts.length === 0) continue
  console.log(`\n=== ${candidate.name}（${attempts.length} 次请求）`)
  for (const event of attempts.slice(-14)) {
    const config = configOf(event.seq)
    const chunks = Array.isArray(event.data?.stream) ? event.data.stream : []
    let finish
    let usage
    let reasoning = 0
    let text = 0
    let toolChunks = 0
    for (const entry of chunks) {
      const chunk = entry.chunk ?? entry
      if (chunk?.type === 'finish') finish = chunk.reason ?? chunk
      if (chunk?.type === 'usage') usage = chunk.usage ?? chunk
      if (chunk?.type === 'reasoning-delta') reasoning += String(chunk.text ?? '').length
      if (chunk?.type === 'text-delta') text += String(chunk.text ?? '').length
      if (chunk?.type === 'tool-call-delta') toolChunks += 1
    }
    const capped = typeof config.maxTokens === 'number' && typeof usage?.outputTokens === 'number' && usage.outputTokens >= config.maxTokens - 2
    const stamp = new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })
    console.log(`  ${stamp} turn ${event.data?.turn} step ${event.data?.step}  ${config.provider ?? '?'}/${config.model ?? '?'}`)
    console.log(`     ${finish?.kind ?? '(无 finish)'}${finish?.failure?.code !== undefined ? ` (${finish.failure.code})` : ''}${capped ? '  ← 打满输出预算' : ''} | max=${config.maxTokens ?? '?'} output=${usage?.outputTokens ?? '?'} reasoning=${usage?.reasoningTokens ?? '?'}`)
    console.log(`     字符 思考=${reasoning} 正文=${text} 工具分片=${toolChunks}`)
    if (finish?.failure?.message !== undefined) console.log(`     failure: ${String(finish.failure.message).slice(0, 160)}`)
  }
}
