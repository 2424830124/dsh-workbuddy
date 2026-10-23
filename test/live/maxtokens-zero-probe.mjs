/**
 * What does the gateway do with `max_tokens: 0`?
 *
 * Two questions, one probe: does it error, and does the error come before or after the
 * entitlement check? Each variant uses a model the account may use and one it may not, so
 * the two error classes can be told apart by which one wins.
 *
 * China deployment only: its probes never start a completion, so this costs nothing.
 * Run: `node test/live/maxtokens-zero-probe.mjs`
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'
import { chatRoutes } from '../../src/regions.js'

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
if (token === undefined || token.length === 0) { console.log('没有大陆版令牌'); process.exit(0) }

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
  'x-session-id': 'maxtokens-probe',
  'x-conversation-id': 'maxtokens-probe',
  'user-agent': route.userAgent
}

const post = async (label, body) => {
  const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const text = await response.text()
  let summary = text.replace(/\s+/g, ' ').slice(0, 220)
  try {
    const json = JSON.parse(text)
    summary = `code=${json.code} msg=${JSON.stringify(json.msg ?? json.message ?? '').slice(0, 120)}`
  } catch { /* SSE or HTML */ }
  console.log(`${label}\n  HTTP ${response.status}  ${summary}\n`)
}

const usable = 'hy3'
// A model this account may not use: 11158 on the entitlement check.
const denied = 'gpt-5.3-codex'

const base = (model, extra) => ({
  model,
  messages: [{ role: 'system', content: '' }],
  stream: true,
  ...extra
})

console.log(`endpoint: ${route.endpoint}\n`)
await post('A 可用的模型 + max_tokens:0', base(usable, { max_tokens: 0 }))
await post('B 可用的模型 + max_tokens:1（对照）', base(usable, { max_tokens: 1 }))
await post('C 无权限的模型 + max_tokens:0', base(denied, { max_tokens: 0 }))
await post('D 无权限的模型 + max_tokens:1（对照）', base(denied, { max_tokens: 1 }))
await post('E 可用的模型 + max_tokens:-1', base(usable, { max_tokens: -1 }))
await post('F 不存在的模型 + max_tokens:0', base('no-such-model-xyz', { max_tokens: 0 }))
