/**
 * Dev probe: which of today's request changes makes the China gateway answer
 * "Illegal API invocation from an unapproved channel"?
 *
 * Sends the same minimal request several times, each time removing one of the fields
 * or headers added on 2026-10-23, and reports the HTTP status and upstream message.
 *
 * Run: `node test/live/cn-header-bisect.mjs [model]`
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

const realFetch = globalThis.fetch
let dropHeaders = new Set()
let dropFields = new Set()
let record = null

globalThis.fetch = async (url, init) => {
  const headers = { ...(init?.headers ?? {}) }
  for (const key of Object.keys(headers)) if (dropHeaders.has(key.toLowerCase())) delete headers[key]
  let body = init?.body
  if (dropFields.size > 0 && typeof body === 'string') {
    const parsed = JSON.parse(body)
    for (const field of dropFields) delete parsed[field]
    body = JSON.stringify(parsed)
  }
  const response = await realFetch(url, { ...init, headers, body })
  const text = await response.clone().text().catch(() => '')
  record = { status: response.status, url: String(url), text }
  return response
}

const variants = [
  { label: '现状（今天的全部改动）', headers: [], fields: [] },
  { label: '去掉 X-Agent-Intent', headers: ['x-agent-intent'], fields: [] },
  { label: '去掉 X-Agent-Runtime / X-Session-ID / X-Model-ID', headers: ['x-agent-runtime', 'x-session-id', 'x-model-id'], fields: [] },
  { label: '去掉全部 X-Conversation-* / X-Request-ID', headers: ['x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id', 'x-request-id'], fields: [] },
  { label: '去掉 stream_options', headers: [], fields: ['stream_options'] },
  { label: '去掉 stream_options + X-Agent-Intent', headers: ['x-agent-intent'], fields: ['stream_options'] },
  { label: '去掉 stream_options + X-Agent-Intent + 新头', headers: ['x-agent-intent', 'x-agent-runtime', 'x-session-id', 'x-model-id'], fields: ['stream_options'] }
]

for (const variant of variants) {
  dropHeaders = new Set(variant.headers)
  dropFields = new Set(variant.fields)
  record = null
  let outcome = ''
  try {
    let finish
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system: 'You are an AI agent powered by DeepSeek Harness.\n\n你是助手。只回答一个"好"字。',
      messages: [{ role: 'user', content: [{ type: 'text', text: '说"好"。' }] }],
      maxTokens: 32,
      signal: AbortSignal.timeout(120_000)
    })) {
      if (chunk.type === 'finish') finish = chunk.reason
    }
    outcome = `成功（finish=${finish?.kind ?? '?'}）`
  } catch (error) {
    outcome = `失败 ${error.code ?? ''}: ${String(error.message).slice(0, 90)}`
  }
  const upstream = record === null ? '' : `${record.status} ${record.text.replace(/\s+/g, ' ').slice(0, 110)}`
  console.log(`\n${variant.label}`)
  console.log(`  结果: ${outcome}`)
  if (upstream !== '') console.log(`  上游: ${upstream}`)
}

globalThis.fetch = realFetch
