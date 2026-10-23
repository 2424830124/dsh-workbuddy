/**
 * How big is the context the long-context probes actually send?
 *
 * The probes pad with ~90k Chinese characters; token count is a different number.
 * This sends that exact payload once and reports the gateway's own `inputTokens`.
 *
 * Run: `node test/live/context-size-probe.mjs [fillerChars…]`
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { readToken } from '../../src/account/auth.js'
import { REGIONS } from '../../src/core/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sizes = process.argv.slice(2).map(Number)
const targets = sizes.length > 0 ? sizes : [0, 30_000, 90_000, 200_000]

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

console.log('填充字符数 → 消息数 → 网关报告的 inputTokens')
for (const size of targets) {
  const messages = [...filler(size), { role: 'user', content: [{ type: 'text', text: '回一个"好"字即可，不要调用工具。' }] }]
  let usage
  try {
    for await (const chunk of adapter.stream({
      provider: 'workbuddy-intl',
      model: 'deepseek-v4.1-flash',
      system: '你是助手。',
      messages,
      maxTokens: 16,
      reasoningEffort: 'high',
      signal: AbortSignal.timeout(300_000)
    })) {
      if (chunk.type === 'usage') usage = chunk.usage
    }
  } catch (error) {
    console.log(`  ${size} 字符 → 请求失败: ${error.code ?? error.message}`)
    continue
  }
  const chars = messages.reduce((sum, message) => sum + message.content.reduce((inner, block) => inner + String(block.text ?? '').length, 0), 0)
  const cache = usage?.cacheReadTokens ?? 0
  const fresh = usage?.inputTokens ?? 0
  console.log(`  ${String(chars).padStart(7)} 字符 → ${String(messages.length).padStart(5)} 条 → inputTokens ${fresh}（缓存命中 ${cache}，合计 ${fresh + cache}）`)
}
