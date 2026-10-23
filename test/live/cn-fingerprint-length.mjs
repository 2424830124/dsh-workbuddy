/**
 * Is the China rejection about prompt *length* rather than a phrase?
 *
 * Each sentence of the rejected paragraph passes on its own, and the whole paragraph
 * fails, so this sends neutral padding of the same size — and the real prefix plus
 * padding — to see whether size alone trips the rule.
 *
 * Run: `node test/live/cn-fingerprint-length.mjs [model]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const region = REGIONS.cn
const model = process.argv[2] ?? 'deepseek-v4.1-flash'

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
if (token === undefined || token.length === 0) { console.log('没有大陆版令牌'); process.exit(0) }
const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

const padTo = (base, target) => {
  let text = base
  while (text.length < target) text += '\n\nThe assistant answers briefly and accurately.'
  return text
}

const cases = [
  { label: '中性提示词 300 字符', text: padTo('You are a helpful assistant.', 300) },
  { label: '中性提示词 1000 字符', text: padTo('You are a helpful assistant.', 1000) },
  { label: '中性提示词 3000 字符', text: padTo('You are a helpful assistant.', 3000) },
  { label: '中性提示词 5000 字符', text: padTo('You are a helpful assistant.', 5000) },
  { label: '中性提示词 5764 字符（与 DSH 同长）', text: padTo('You are a helpful assistant.', 5764) },
  { label: '中性提示词 10000 字符', text: padTo('You are a helpful assistant.', 10000) }
]

for (const item of cases) {
  let outcome
  try {
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system: item.text,
      messages: [{ role: 'user', content: [{ type: 'text', text: '说"好"。' }] }],
      maxTokens: 16,
      signal: AbortSignal.timeout(180_000)
    })) void chunk
    outcome = '✅ 通过'
  } catch (error) {
    outcome = /unapproved channel/i.test(String(error.message)) ? '❌ 被拦' : `⚠️ ${error.code ?? ''}`
  }
  console.log(`${item.label}（实际 ${item.text.length} 字符）\n  → ${outcome}`)
}
