/**
 * Dev probe: the real DSH system prompt, the real 70 tools, a long context — does the
 * model still call a tool?
 *
 * The harness writes its full system prompt into the session as a `system/message`
 * event, so this uses the exact text instead of a hand-written stand-in, which is what
 * earlier probes did. It also answers "is the tool list actually delivered?" by asking
 * the model to name a tool from the list.
 *
 * Overseas free deepseek-v4.1-flash only.
 * Run: `node test/live/dsh-prompt-probe.mjs [rounds] [fillerChars…]`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { readToken } from '../../src/account/auth.js'
import { REGIONS } from '../../src/core/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 3)
const sizes = process.argv.slice(3).map(Number)
const targets = sizes.length > 0 ? sizes : [0, 90_000, 280_000]
const region = REGIONS.intl
const model = 'deepseek-v4.1-flash'

// --- the session that carries the harness prompt and the 70-tool set ---
const sessionsRoot = join(home, 'sessions')
let dir
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  const found = names.find((name) => name.includes('1fccb097'))
  if (found !== undefined) { dir = join(projectDir, found); break }
}
if (dir === undefined) { console.log('找不到会话 1fccb097'); process.exit(1) }

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

/** Concatenated text of a transcript message. */
const textOf = (message) => (Array.isArray(message?.content)
  ? message.content.map((block) => String(block?.text ?? '')).join('')
  : String(message?.content ?? ''))

const prompts = events.filter((event) => event.type === 'system/message').map((event) => textOf(event.data?.message))
const system = prompts.find((text) => text.includes('deepseek-v4.1-flash model')) ?? prompts.at(-1)
console.log(`系统提示词: ${system.length} 字符（取自会话，含 "deepseek-v4.1-flash model" 那一版）`)
console.log(`开头: ${system.slice(0, 90).replace(/\n/g, ' ')}…`)

const header = events.filter((event) => event.type === 'request/header').at(-1)
const tools = header?.data?.header?.tools ?? []
const nameOf = (tool) => tool?.function?.name ?? tool?.name
console.log(`工具集: ${tools.length} 个（${tools.slice(0, 6).map(nameOf).join(', ')} …）\n`)

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
const token = await readToken(ctx, region)
if (token === undefined || token.length === 0) { console.log('没有海外版令牌'); process.exit(0) }
const adapter = new WorkBuddyAdapter(ctx, region)
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

for (const size of targets) {
  const messages = [...filler(size), {
    role: 'user',
    content: [{ type: 'text', text: '现在把 E:\\Projects\\demo\\src\\index.js 里的 console.log("a") 改成 console.log("b")。' }]
  }]
  let calls = 0
  let stops = 0
  let errors = 0
  const rows = []
  for (let round = 1; round <= rounds; round += 1) {
    let finish
    let diagnostics
    let text = ''
    let toolBlocks = 0
    let toolNames = []
    try {
      for await (const chunk of adapter.stream({
        provider: region.provider,
        model,
        system,
        messages,
        tools,
        maxTokens: 1024,
        reasoningEffort: 'high',
        signal: AbortSignal.timeout(300_000)
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') { toolBlocks += 1; toolNames.push(chunk.block.name) }
        if (chunk.type === 'finish') { finish = chunk.reason; diagnostics = chunk.response }
      }
    } catch (error) {
      errors += 1
      rows.push(`抛错:${error.code ?? error.message}`)
      continue
    }
    const raw = diagnostics?.stopReason ?? '?'
    if (finish?.kind === 'tool-calls' || toolBlocks > 0) { calls += 1; rows.push(`call[${raw}] ${toolNames.join(',')}`) }
    else if (finish?.kind === 'stop') { stops += 1; rows.push(`STOP[${raw}]「${text.trim().slice(0, 40)}」`) }
    else rows.push(`${finish?.kind}[${raw}]`)
  }
  console.log(`输入 ~${Math.round(size / 1000)}k 字符 / ${messages.length} 条 —— 工具调用 ${calls}/${rounds}，提前 stop ${stops}/${rounds}，抛错 ${errors}`)
  for (const row of rows) console.log(`   · ${row}`)
  console.log()
}
