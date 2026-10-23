/**
 * Dev probe: is `thinking:{type:'enabled'}` load-bearing, or does `reasoning_effort`
 * alone make the DeepSeek family think?
 *
 * The official CLI sends `thinking:{type:'disabled'}` only when thinking is off, so
 * it never sends the `enabled` form this plugin pins. This measures whether dropping
 * it changes how much the model reasons.
 *
 * Run: `node test/live/thinking-field-probe.mjs [rounds] [modelId]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 3)
const model = process.argv[3] ?? 'deepseek-v4.1-flash'
const region = REGIONS[process.argv[4] ?? 'intl']

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
if (token === undefined || token.length === 0) { console.log('没有令牌'); process.exit(0) }

const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

// Rewrite the outgoing body per variant.
const realFetch = globalThis.fetch
let rewrite = (body) => body
globalThis.fetch = async (url, init) => {
  if (typeof init?.body === 'string') {
    try { init = { ...init, body: JSON.stringify(rewrite(JSON.parse(init.body))) } } catch { /* forward */ }
  }
  return realFetch(url, init)
}

const messages = [{
  role: 'user',
  content: [{ type: 'text', text: '计算 847 × 293，并说明中间步骤。只回答结果和步骤，不要用工具。' }]
}]

const variants = [
  {
    label: '现状：thinking:{type:enabled} + reasoning_effort=high',
    rewrite: (body) => body
  },
  {
    label: '去掉 thinking，只留 reasoning_effort=high',
    rewrite: (body) => { delete body.thinking; return body }
  },
  {
    label: 'thinking:{type:enabled} + reasoning_effort=max',
    rewrite: (body) => { body.thinking = { type: 'enabled' }; body.reasoning_effort = 'max'; return body }
  },
  {
    label: '去掉 thinking + reasoning_effort=max',
    rewrite: (body) => { delete body.thinking; body.reasoning_effort = 'max'; return body }
  },
  {
    label: '两个都去掉（对照组：真不思考？）',
    rewrite: (body) => { delete body.thinking; delete body.reasoning_effort; return body }
  }
]

for (const variant of variants) {
  rewrite = variant.rewrite
  const reasoningChars = []
  const reasoningTokens = []
  const outputTokens = []
  let errors = 0
  for (let round = 1; round <= rounds; round += 1) {
    let reasoning = ''
    let usage
    try {
      for await (const chunk of adapter.stream({
        provider: region.provider,
        model,
        system: '你是一个严谨的数学助手。',
        messages,
        maxTokens: 4096,
        reasoningEffort: 'high',
        signal: AbortSignal.timeout(180_000)
      })) {
        if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? ''
        if (chunk.type === 'usage') usage = chunk.usage
      }
    } catch (error) {
      errors += 1
      continue
    }
    reasoningChars.push(reasoning.length)
    reasoningTokens.push(usage?.reasoningTokens ?? 0)
    outputTokens.push(usage?.outputTokens ?? 0)
  }
  const avg = (list) => (list.length === 0 ? '—' : (list.reduce((a, b) => a + b, 0) / list.length).toFixed(0))
  console.log(`\n${variant.label}`)
  console.log(`  思考字符 ${avg(reasoningChars)}（每次 ${reasoningChars.join('/') || '—'}）`)
  console.log(`  reasoning_tokens ${avg(reasoningTokens)}   输出 tokens ${avg(outputTokens)}   错误 ${errors}`)
}

globalThis.fetch = realFetch
