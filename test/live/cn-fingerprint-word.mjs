/** Confirm the new China fingerprint: is it the literal phrase "DeepSeek Harness"? */
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

const cases = [
  { label: '含 "DeepSeek Harness"（在正文里）', text: 'You are a helpful assistant.\n\nYou interact through the DeepSeek Harness Web GUI.' },
  { label: '改成 "this harness"', text: 'You are a helpful assistant.\n\nYou interact through this harness Web GUI.' },
  { label: '只出现 "DeepSeek Harness" 两词', text: 'You are a helpful assistant.\n\nDeepSeek Harness' },
  { label: '只出现 "DeepSeek"', text: 'You are a helpful assistant.\n\nDeepSeek' },
  { label: '只出现 "Harness"', text: 'You are a helpful assistant.\n\nHarness' },
  { label: '改成 "DSH Harness"', text: 'You are a helpful assistant.\n\nDSH Harness' },
  { label: '小写 "deepseek harness"', text: 'You are a helpful assistant.\n\ndeepseek harness' }
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
      signal: AbortSignal.timeout(120_000)
    })) void chunk
    outcome = '✅ 通过'
  } catch (error) {
    outcome = /unapproved channel/i.test(String(error.message)) ? '❌ 被拦（指纹命中）' : `⚠️ 其它错误 ${error.code ?? ''}`
  }
  console.log(`${item.label}\n  → ${outcome}`)
}
