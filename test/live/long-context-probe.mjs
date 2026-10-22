/**
 * Dev probe: does the early stop appear only once the context is long?
 *
 * The same tool-using instruction, preceded by a synthetic conversation of a chosen
 * size. If the tool-call rate collapses as the filler grows, the trigger is context
 * length, not the schema, the sampling or the parser — and the numbers say from
 * about where.
 *
 * Run: `node test/live/long-context-probe.mjs [rounds] [modelId]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 2)
const model = process.argv[3] ?? 'deepseek-v4.1-flash'

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

const writeTool = {
  name: 'write',
  description: 'Write a file.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content']
  }
}

/** A plausible prior conversation of roughly `chars` characters. */
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

const instruction = {
  role: 'user',
  content: [{ type: 'text', text: '现在把 E:\\Projects\\demo\\src\\index.js 里的 console.log("a") 改成 console.log("b")，用 write 工具直接改，不要解释。' }]
}

const sizes = [0, 30_000, 90_000]
for (const size of sizes) {
  const messages = [...filler(size), instruction]
  const chars = messages.reduce((sum, message) => sum + message.content.reduce((inner, block) => inner + String(block.text ?? '').length, 0), 0)
  let calls = 0
  let stops = 0
  let errors = 0
  const samples = []
  for (let round = 1; round <= rounds; round += 1) {
    let finish
    let text = ''
    let toolBlocks = 0
    const started = Date.now()
    try {
      for await (const chunk of adapter.stream({
        provider: 'workbuddy-intl',
        model,
        system: '你是动手型编程助手：需要改文件时直接调用工具，不要先叙述。',
        messages,
        tools: [writeTool],
        maxTokens: 1024,
        reasoningEffort: 'high',
        signal: AbortSignal.timeout(300_000)
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
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (finish?.kind === 'tool-calls' || toolBlocks > 0) { calls += 1; samples.push(`call(${seconds}s)`) }
    else if (finish?.kind === 'stop') { stops += 1; samples.push(`STOP(${seconds}s,正文 ${text.length} 字:${text.slice(0, 20)})`) }
    else samples.push(`${finish?.kind ?? '(无)'}(${seconds}s)`)
  }
  console.log(`\n输入约 ${Math.round(chars / 1000)}k 字符 / ${messages.length} 条消息`)
  console.log(`  调用工具 ${calls}/${rounds}   提前 stop ${stops}/${rounds}   抛错 ${errors}`)
  console.log(`  ${samples.join(' | ')}`)
}
