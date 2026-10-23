/**
 * Dev probe: does the system prompt stop the "I need to read first, so I stop"
 * ending?
 *
 * The failing sentences are all the model declaring it lacks information and then
 * ending the turn instead of calling `read`. Same long context, two system prompts:
 * one neutral, one that makes the tool the only acceptable next move.
 *
 * Run: `node test/live/prompt-ab-probe.mjs [rounds] [modelId]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 8)
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

const tools = [
  {
    name: 'read',
    description: 'Read a file. Use this whenever you need to see file contents.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  },
  {
    name: 'write',
    description: 'Write a file.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content']
    }
  }
]

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

const prompts = [
  { label: '中性', system: '你是一个编程助手。' },
  {
    label: '工具强制（读不到就调 read，别停下来解释）',
    system: '你是动手型编程助手。规则：1) 需要文件内容时立刻调用 read，不要凭记忆猜测，也不要停下来解释或询问；2) 修改文件时调用 write；3) 只有在任务真正完成后才结束回复。绝不要用"我需要先读取…"这类句子结束回答。'
  }
]

for (const prompt of prompts) {
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
        model,
        system: prompt.system,
        messages,
        tools,
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
    if (finish?.kind === 'tool-calls' || toolBlocks > 0) { calls += 1; samples.push('call') }
    else if (finish?.kind === 'stop') { stops += 1; samples.push(`STOP(${text.slice(0, 16)})`) }
    else samples.push(finish?.kind ?? '(无)')
  }
  console.log(`\n${prompt.label}`)
  console.log(`  调用工具 ${calls}/${rounds}   提前 stop ${stops}/${rounds}   抛错 ${errors}`)
  console.log(`  ${samples.join(' | ')}`)
}
