/**
 * Dev probe: can the gateway still use our tool schemas?
 *
 * A model that "announces the tool call and stops" can also be a model that *cannot*
 * emit one: if the gateway drops or rejects part of the tool list, the call never
 * arrives and the turn ends after a sentence. This replays the tool list that was
 * actually sent (from a session's request header) against reduced variants, so the
 * difference is measured rather than guessed.
 *
 * Run: `node test/live/tools-probe.mjs [sessionPrefix] [rounds]`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sessionsRoot = join(home, 'sessions')
const prefix = process.argv[2] ?? '6eb8dacf'
const rounds = Number(process.argv[3] ?? 4)

let dir
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  const found = names.find((name) => name.includes(prefix))
  if (found !== undefined) { dir = join(projectDir, found); break }
}
if (dir === undefined) { console.log('没有匹配的会话:', prefix); process.exit(1) }

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

// The newest request header that targeted the overseas deployment.
const headers = events.filter((event) => event.type === 'request/header')
const header = [...headers].reverse().find((event) => event.data?.header?.config?.provider === 'workbuddy-intl')
if (header === undefined) { console.log('该会话没有海外版请求头'); process.exit(1) }
const config = header.data.header.config
const tools = Array.isArray(header.data.header.tools) ? header.data.header.tools : []
console.log(`会话 ${dir.split(/[\\/]/).pop()}`)
console.log(`请求: ${config.provider}/${config.model}  tools=${tools.length} 个`)

const token = await readToken({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const path = `${home}/.credentials.yaml`
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(path, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}, REGIONS.intl)
if (token === undefined || token.length === 0) { console.log('没有海外版令牌'); process.exit(0) }

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => ({ value: token }) },
  get: () => undefined
}
const adapter = new WorkBuddyAdapter(ctx, REGIONS.intl)
adapter.catalog = []
adapter.catalogAt = Date.now()

const prompt = '请把 E:\\Projects\\demo\\src\\index.js 里的 console.log("a") 改成 console.log("b")，用 write 工具直接改，不要解释。'
const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]

const writeTool = tools.find((tool) => tool.name === 'write') ?? {
  name: 'write',
  description: 'Write a file.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }
}
const simpleTool = {
  name: 'write',
  description: 'Write a file.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content']
  }
}

const variants = [
  { label: `全部 ${tools.length} 个工具`, tools },
  { label: '仅 write（原样 schema）', tools: [writeTool] },
  { label: '仅 write（简化 schema）', tools: [simpleTool] }
]

for (const variant of variants) {
  let calls = 0
  let stops = 0
  let errors = 0
  const samples = []
  for (let round = 1; round <= rounds; round += 1) {
    let finish
    let text = ''
    let toolBlocks = 0
    try {
      for await (const chunk of adapter.stream({
        provider: 'workbuddy-intl',
        model: config.model,
        system: '你是动手型编程助手：需要改文件时直接调用工具，不要先叙述。',
        messages,
        tools: variant.tools,
        maxTokens: 1024,
        reasoningEffort: config.reasoningEffort,
        signal: AbortSignal.timeout(120_000)
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolBlocks += 1
        if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      errors += 1
      samples.push(`抛错:${error.code ?? error.message}`)
      continue
    }
    if (finish?.kind === 'tool-calls' || toolBlocks > 0) { calls += 1; samples.push('call') }
    else if (finish?.kind === 'stop') { stops += 1; samples.push(`stop(${text.slice(0, 24)})`) }
    else samples.push(finish?.kind ?? '(无)')
  }
  console.log(`\n${variant.label}`)
  console.log(`  调用工具 ${calls}/${rounds}  提前 stop ${stops}/${rounds}  抛错 ${errors}`)
  console.log(`  ${samples.join(' | ')}`)
}
