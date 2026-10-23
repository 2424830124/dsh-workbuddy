/**
 * Dev probe: reproduce the mid-answer stop and print upstream's raw finish_reason.
 *
 * Earlier runs showed the difference between "the model calls read" and "the model
 * says it needs to read, then stops" is whether `read` is actually offered. This
 * replays the real 70-tool set (from the session that failed) with and without it,
 * over a long context, and prints the raw `finish_reason` each time.
 *
 * Run: `node test/live/repro-probe.mjs [rounds] [modelId]`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 6)
const model = process.argv[3] ?? 'deepseek-v4.1-flash'

// The tool list the failing session actually sent.
const sessionsRoot = join(home, 'sessions')
let dir
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  const found = names.find((name) => name.includes('6eb8dacf'))
  if (found !== undefined) { dir = join(projectDir, found); break }
}
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
const header = [...events].reverse().find((event) => event.type === 'request/header' && event.data?.header?.config?.provider === 'workbuddy-intl')
const realTools = header?.data?.header?.tools ?? []
// Tools arrive in OpenAI shape: { type:'function', function:{ name, … } }.
const nameOf = (tool) => tool?.function?.name ?? tool?.name
const readLike = realTools.filter((tool) => ['read', 'glob', 'grep', 'ls', 'list_files'].includes(nameOf(tool)))
console.log(`真实工具集 ${realTools.length} 个；其中"读取类" ${readLike.length} 个：${readLike.map(nameOf).join(', ')}`)

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(`${home}/.credentials.yaml`, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  },
  get: () => undefined
}
const token = await readToken(ctx, REGIONS.intl)
if (token === undefined || token.length === 0) { console.log('没有海外版令牌'); process.exit(0) }
const adapter = new WorkBuddyAdapter(ctx, REGIONS.intl)
adapter.catalog = []
adapter.catalogAt = Date.now()

const filler = (chars) => {
  const messages = []
  let produced = 0
  let index = 0
  while (produced < chars) {
    const step = `第 ${index + 1} 步：读取 src/module${index}.js，把其中的 TODO 注释替换为实现说明，然后运行单测确认通过。`
    messages.push({ role: 'user', content: [{ type: 'text', text: step }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `已处理 src/module${index}.js：替换了 ${index % 7 + 1} 处 TODO，单测通过。` }] })
    produced += step.length + 40
    index += 1
  }
  return messages
}
const messages = [...filler(90_000), {
  role: 'user',
  content: [{ type: 'text', text: '现在把 E:\\Projects\\demo\\src\\index.js 里的 console.log("a") 改成 console.log("b")。' }]
}]

const variants = [
  { label: `真实 70 工具（含 read）`, tools: realTools },
  { label: `70 工具但去掉读取类工具`, tools: realTools.filter((tool) => !readLike.includes(tool)) }
]

for (const variant of variants) {
  let calls = 0
  let stops = 0
  let errors = 0
  const rows = []
  for (let round = 1; round <= rounds; round += 1) {
    let finish
    let diagnostics
    let text = ''
    let toolBlocks = 0
    try {
      for await (const chunk of adapter.stream({
        provider: 'workbuddy-intl',
        model,
        system: '你是一个编程助手。',
        messages,
        tools: variant.tools,
        maxTokens: 1024,
        reasoningEffort: 'high',
        signal: AbortSignal.timeout(300_000)
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolBlocks += 1
        if (chunk.type === 'finish') { finish = chunk.reason; diagnostics = chunk.response }
      }
    } catch (error) {
      errors += 1
      rows.push(`抛错:${error.code ?? error.message}`)
      continue
    }
    const raw = diagnostics?.stopReason ?? '?'
    if (finish?.kind === 'tool-calls' || toolBlocks > 0) { calls += 1; rows.push(`call[${raw}]`) }
    else if (finish?.kind === 'stop') { stops += 1; rows.push(`STOP[${raw}]「${text.slice(0, 22)}」`) }
    else rows.push(`${finish?.kind}[${raw}]`)
  }
  console.log(`\n${variant.label}`)
  console.log(`  调用工具 ${calls}/${rounds}   提前 stop ${stops}/${rounds}   抛错 ${errors}`)
  for (const row of rows) console.log(`   · ${row}`)
}
