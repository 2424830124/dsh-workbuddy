/**
 * Dev probe: long context × tool-set size.
 *
 * The early stop reproduced with a long context and a two-tool set, then vanished
 * when `read` was added — the model was asked to edit a file, could not read it, and
 * ended the turn saying so. A real session offers ~70 tools, so the question is
 * whether a large tool list survives a long context at all.
 *
 * Run: `node test/live/long-tools-probe.mjs [rounds] [modelId]`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 8)
const model = process.argv[3] ?? 'deepseek-v4.1-flash'

// The real tool list, from the session that failed.
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
if (dir !== undefined) {
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
}
const header = [...events].reverse().find((event) => event.type === 'request/header' && event.data?.header?.config?.provider === 'workbuddy-intl')
const allTools = header?.data?.header?.tools ?? []
console.log(`真实工具集: ${allTools.length} 个`)

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

const readTool = {
  name: 'read',
  description: 'Read a file. Use this whenever you need to see file contents.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
}
const writeTool = {
  name: 'write',
  description: 'Write a file.',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }
}

const variants = [
  { label: '2 个工具（read + write）', tools: [readTool, writeTool] },
  { label: `真实工具集（${allTools.length} 个）`, tools: allTools },
  { label: '真实工具集去掉 read', tools: allTools.filter((tool) => tool.name !== 'read') }
]

for (const variant of variants) {
  let calls = 0
  let stops = 0
  let errors = 0
  let readCalls = 0
  const samples = []
  for (let round = 1; round <= rounds; round += 1) {
    let finish
    let text = ''
    let toolBlocks = 0
    let usedRead = false
    try {
      for await (const chunk of adapter.stream({
        provider: 'workbuddy-intl',
        model,
        system: '你是动手型编程助手：需要文件内容时直接调用 read；修改时调用 write；任务没完成前不要结束回复。',
        messages,
        tools: variant.tools,
        maxTokens: 1024,
        reasoningEffort: 'high',
        signal: AbortSignal.timeout(300_000)
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          toolBlocks += 1
          if (chunk.block.name === 'read') usedRead = true
        }
        if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      errors += 1
      samples.push(`抛错:${error.code ?? error.message}`)
      continue
    }
    if (usedRead) readCalls += 1
    if (finish?.kind === 'tool-calls' || toolBlocks > 0) { calls += 1; samples.push(usedRead ? 'read' : 'call') }
    else if (finish?.kind === 'stop') { stops += 1; samples.push(`STOP(${text.slice(0, 16)})`) }
    else samples.push(finish?.kind ?? '(无)')
  }
  console.log(`\n${variant.label}`)
  console.log(`  调用工具 ${calls}/${rounds}（其中先 read ${readCalls}）  提前 stop ${stops}/${rounds}  抛错 ${errors}`)
  console.log(`  ${samples.join(' | ')}`)
}
