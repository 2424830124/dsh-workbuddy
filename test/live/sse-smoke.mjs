/** End-to-end check of the new SSE transport, against the free China deployment. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { readToken } from '../../src/account/auth.js'
import { REGIONS } from '../../src/core/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const region = REGIONS.cn

const ctx = {
  logger: { info: () => {}, warn: (...args) => console.log('warn:', args.join(' ').slice(0, 160)), error: () => {} },
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

const chunks = []
let text = ''
try {
  for await (const chunk of adapter.stream({
    provider: region.provider,
    model: 'deepseek-v4.1-flash',
    system: '你是一个简洁的助手。',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
    maxTokens: 32,
    reasoningEffort: 'high',
    signal: AbortSignal.timeout(60_000)
  })) {
    chunks.push(chunk.type)
    if (chunk.type === 'text-delta') text += chunk.text ?? ''
  }
} catch (error) {
  console.log('失败:', error.code, String(error.message).slice(0, 200))
  process.exit(1)
}
const finish = chunks.at(-1)
console.log('chunk 序列:', [...new Set(chunks)].join(' → '))
console.log('正文:', JSON.stringify(text.trim().slice(0, 40)))
console.log('最后一个 chunk:', finish, '（finish 在最后 = 流式收尾正常）')
