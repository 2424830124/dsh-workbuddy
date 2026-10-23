/** Does `max_tokens: 0` actually start a completion (and cost tokens)? */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/account/auth.js'
import { REGIONS, chatRoutes } from '../../src/core/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const region = REGIONS.cn

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(`${home}/.credentials.yaml`, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}
const token = await readToken(ctx, region)
const route = chatRoutes(region)[0]
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'x-domain': route.apiDomain,
  'x-product': 'SaaS',
  'x-product-code': route.productCode,
  'x-agent-purpose': 'conversation',
  'x-agent-intent': 'craft',
  'x-agent-runtime': 'local-agent',
  'x-ide-name': route.ideName,
  'x-ide-type': route.ideName,
  'x-ide-version': route.ideVersion,
  'x-session-id': 'maxtokens-probe2',
  'x-conversation-id': 'maxtokens-probe2',
  'user-agent': route.userAgent
}

const run = async (label, body) => {
  const started = Date.now()
  const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body)
  })
  const text = await response.text()
  const elapsed = Date.now() - started
  const frames = text.split('\n').filter((line) => line.startsWith('data:')).length
  const hasContent = /"content":"[^"]+"/.test(text)
  const hasUsage = /"usage"\s*:\s*\{/.test(text)
  const usageMatch = /"completion_tokens"\s*:\s*(\d+)/.exec(text)
  console.log(`${label}`)
  console.log(`  HTTP ${response.status}  用时 ${elapsed}ms  data 帧 ${frames}  有正文 ${hasContent}  有 usage ${hasUsage}${usageMatch === null ? '' : `  completion_tokens=${usageMatch[1]}`}`)
  const tail = text.replace(/\s+/g, ' ').slice(-260)
  console.log(`  尾部: ${tail}\n`)
}

const withPrompt = (extra) => ({
  model: 'hy3',
  messages: [{ role: 'user', content: '说一句你好' }],
  stream: true,
  ...extra
})

await run('1) 有正文提示词 + max_tokens:0', withPrompt({ max_tokens: 0 }))
await run('2) 有正文提示词 + max_tokens:1', withPrompt({ max_tokens: 1 }))
await run('3) 有正文提示词 + 不给 max_tokens', withPrompt({}))
await run('4) 空 messages（CN 探测形态）+ max_tokens:0', { model: 'hy3', messages: [], stream: true, max_tokens: 0 })
