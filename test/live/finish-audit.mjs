/**
 * Why does a turn end with no tool call?
 *
 * `assistant/attempt` stores the whole stream, so the finish reason, the usage
 * frame and whether any tool-call delta arrived are all recoverable. The case to
 * catch is an upstream `stop` whose output tokens sit at the request's cap: the
 * model spent its budget on reasoning, the answer simply stops, and nothing looks
 * like an error.
 *
 * Run: `node test/live/finish-audit.mjs [sessionIdPrefix] [attempts]`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const projectDir = join(home, 'sessions', '--E-Projects-dsh-workbuddy--')
const wanted = process.argv[2]
const limit = Number(process.argv[3] ?? 12)

const sessions = readdirSync(projectDir).filter((name) => {
  try { return statSync(join(projectDir, name)).isDirectory() } catch { return false }
})
const resolved = wanted === undefined
  ? sessions.map((name) => ({ name, at: statSync(join(projectDir, name)).mtimeMs })).sort((a, b) => b.at - a.at)[0].name
  : sessions.find((name) => name.includes(wanted))
if (resolved === undefined) { console.log('没有匹配的会话'); process.exit(1) }
console.log('会话:', resolved)

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

// The request headers carry what was asked for, including the output budget.
const headers = events.filter((event) => event.type === 'request/header')
const budget = (turn, step) => {
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const data = headers[index].data ?? {}
    if (data.turn === turn && data.step === step) {
      const body = data.body ?? {}
      return { maxTokens: body.max_tokens, reasoningEffort: body.reasoning_effort, model: body.model }
    }
  }
  return {}
}

const attempts = events.filter((event) => event.type === 'assistant/attempt')
console.log(`attempt ${attempts.length} 个，request/header ${headers.length} 个\n`)

const rows = []
for (const event of attempts) {
  const data = event.data ?? {}
  const chunks = Array.isArray(data.stream) ? data.stream : []
  let finish
  let usage
  let reasoningChars = 0
  let textChars = 0
  let toolChunks = 0
  for (const entry of chunks) {
    const chunk = entry.chunk ?? entry
    const type = chunk?.type ?? ''
    if (type === 'finish') finish = chunk.reason ?? chunk
    if (type === 'usage') usage = chunk.usage ?? chunk
    if (type === 'reasoning-delta') reasoningChars += String(chunk.text ?? '').length
    if (type === 'text-delta') textChars += String(chunk.text ?? '').length
    if (type === 'tool-call-delta') toolChunks += 1
  }
  rows.push({ turn: data.turn, step: data.step, kind: finish?.kind ?? '?', finish, usage, reasoningChars, textChars, toolChunks })
}
for (const row of rows.slice(-limit)) {
  const asked = budget(row.turn, row.step)
  const out = row.usage?.outputTokens ?? '?'
  const reasoning = row.usage?.reasoningTokens ?? '?'
  const capped = typeof asked.maxTokens === 'number' && typeof out === 'number' && out >= asked.maxTokens - 2
  console.log(`turn ${row.turn} step ${row.step}  ${row.kind}${capped ? '  ← 输出达到预算上限' : ''}`)
  console.log(`   model=${asked.model ?? '?'} max_tokens=${asked.maxTokens ?? '?'} effort=${asked.reasoningEffort ?? '-'}`)
  console.log(`   usage: output=${out} reasoning=${reasoning} | 字符: 思考=${row.reasoningChars} 正文=${row.textChars} 工具分片=${row.toolChunks}`)
  if (row.finish?.failure !== undefined) console.log(`   failure: ${JSON.stringify(row.finish.failure).slice(0, 160)}`)
}

const capped = rows.filter((row) => {
  const asked = budget(row.turn, row.step)
  return typeof asked.maxTokens === 'number' && typeof row.usage?.outputTokens === 'number' && row.usage.outputTokens >= asked.maxTokens - 2
})
console.log(`\n输出打满预算的 attempt: ${capped.length}/${rows.length}`)
for (const row of capped.slice(-6)) console.log(`   turn ${row.turn} step ${row.step}  ${row.kind}  output=${row.usage?.outputTokens}`)

const noTool = rows.filter((row) => row.kind === 'stop' && row.toolChunks === 0)
console.log(`\n以 stop 结束、且没有任何工具调用的 attempt: ${noTool.length}`)
for (const row of noTool.slice(-6)) {
  const asked = budget(row.turn, row.step)
  console.log(`   turn ${row.turn} step ${row.step}  output=${row.usage?.outputTokens ?? '?'}/${asked.maxTokens ?? '?'} 思考字符=${row.reasoningChars} 正文字符=${row.textChars}`)
}
