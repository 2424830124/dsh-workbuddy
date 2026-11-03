/**
 * Does the China gateway reject prompts by how often the vendor brand appears?
 *
 * The full harness prompt fails while the same prompt minus its last paragraph passes,
 * and every sentence of that paragraph passes alone — which points at an accumulated
 * count rather than a phrase. This varies the number of "DeepSeek" mentions directly.
 *
 * Run: `node test/live/cn-fingerprint-count.mjs [model]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { readToken } from '../../src/account/auth.js'
import { REGIONS } from '../../src/core/regions.js'

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

const run = async (system) => {
  try {
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: '说"好"。' }] }],
      maxTokens: 16,
      signal: AbortSignal.timeout(180_000)
    })) void chunk
    return '✅ 通过'
  } catch (error) {
    return /unapproved channel/i.test(String(error.message)) ? '❌ 被拦' : `⚠️ ${error.code ?? ''}`
  }
}

console.log('## 品牌词次数')
for (const count of [1, 2, 3, 4, 5, 6, 8, 12]) {
  const system = `You are a helpful assistant.\n\n${Array.from({ length: count }, () => 'DeepSeek Harness').join(' and ')}`
  console.log(`  "DeepSeek Harness" ×${count} → ${await run(system)}`)
}

console.log('\n## 换成原名 Harness / 全小写')
console.log(`  "harness" ×8 → ${await run(`You are a helpful assistant.\n\n${Array.from({ length: 8 }, () => 'harness').join(' and ')}`)}`)

console.log('\n## 只有一个特性短语，重复多次')
for (const count of [1, 3, 5]) {
  const phrase = 'The client-plugin HMR receiver is active.'
  console.log(`  "${phrase.slice(0, 28)}…" ×${count} → ${await run(`You are a helpful assistant.\n\n${Array.from({ length: count }, () => phrase).join(' ')}`)}`)
}
