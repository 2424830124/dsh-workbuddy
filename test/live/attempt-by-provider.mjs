/** Pair each attempt with the request header that preceded it, to name the provider. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const projectDir = join(home, 'sessions', '--E-Projects-dsh-workbuddy--')
const resolved = process.argv[2] === undefined
  ? readdirSync(projectDir)
    .filter((name) => { try { return statSync(join(projectDir, name)).isDirectory() } catch { return false } })
    .map((name) => ({ name, at: statSync(join(projectDir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0].name
  : readdirSync(projectDir).find((name) => name.includes(process.argv[2]))
console.log('会话:', resolved)

const dir = join(projectDir, resolved)
const file = readdirSync(dir).find((name) => name.endsWith('.zstd'))
const buffer = readFileSync(join(dir, file))
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const parts = []
let at = buffer.indexOf(magic)
while (at >= 0) {
  try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn */ }
  at = buffer.indexOf(magic, at + 4)
}
const events = Buffer.concat(parts).toString('utf8').split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)

const headers = events.filter((event) => event.type === 'request/header')
const providerOf = (seq) => {
  let found
  for (const header of headers) {
    if (header.seq > seq) break
    found = header.data?.header?.config
  }
  return found ?? {}
}

const attempts = events.filter((event) => event.type === 'assistant/attempt')
const rows = attempts.map((event) => {
  const config = providerOf(event.seq)
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
  return {
    seq: event.seq,
    time: event.time,
    turn: event.data?.turn,
    step: event.data?.step,
    provider: config.provider ?? '?',
    model: config.model ?? '?',
    maxTokens: config.maxTokens,
    effort: config.reasoningEffort,
    kind: finish?.kind ?? '(无 finish)',
    code: finish?.failure?.code,
    usage,
    reasoning,
    text,
    toolChunks
  }
})

const cutoff = Number(process.argv[3] ?? 0)
const shown = cutoff > 0 ? rows.filter((row) => row.time >= cutoff) : rows.slice(-24)
console.log(`attempt 共 ${rows.length} 个；显示 ${shown.length} 个\n`)
for (const row of shown) {
  const stamp = new Date(row.time).toLocaleTimeString('zh-CN', { hour12: false })
  const capped = typeof row.maxTokens === 'number' && typeof row.usage?.outputTokens === 'number' && row.usage.outputTokens >= row.maxTokens - 2
  console.log(`${stamp} turn ${row.turn} step ${row.step}  ${row.provider}/${row.model}  max=${row.maxTokens ?? '?'} effort=${row.effort ?? '-'}`)
  console.log(`   ${row.kind}${row.code !== undefined ? ` (${row.code})` : ''}${capped ? '  ← 打满输出预算' : ''} | output=${row.usage?.outputTokens ?? '?'} reasoning=${row.usage?.reasoningTokens ?? '?'} | 字符 思考=${row.reasoning} 正文=${row.text} 工具分片=${row.toolChunks}`)
}

const byProvider = new Map()
for (const row of rows) byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + 1)
console.log('\n各 provider 的 attempt 数:', [...byProvider].map(([provider, count]) => `${provider}=${count}`).join('  '))

const ours = rows.filter((row) => /workbuddy/.test(row.provider))
console.log(`\n我们的 provider：${ours.length} 个 attempt`)
const oursKinds = new Map()
for (const row of ours) oursKinds.set(`${row.kind}${row.code !== undefined ? ` (${row.code})` : ''}`, (oursKinds.get(`${row.kind}${row.code !== undefined ? ` (${row.code})` : ''}`) ?? 0) + 1)
for (const [kind, count] of oursKinds) console.log(`   ${count} × ${kind}`)
