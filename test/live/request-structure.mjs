/**
 * Dev probe: which request shapes does a *non-deepseek* model actually accept?
 *
 * The adapter sends `thinking: {type:'enabled'}` only to the deepseek family,
 * because that field is the one the official client is known to send there. This
 * checks the neighbours instead of assuming: for each variant it reports the HTTP
 * status, the business code, and whether the stream produced reasoning or an
 * answer at all — so "unknown field tolerated", "field validated", and "shape
 * rejected" stop being guesses.
 *
 * Run: `node test/live/request-structure.mjs [region] [model]`
 *   node test/live/request-structure.mjs intl step-5-preview
 *   node test/live/request-structure.mjs intl hy3
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/account/auth.js'
import { fetchModelEntries } from '../../src/catalog/catalog.js'
import { chatRoutes, REGIONS } from '../../src/core/regions.js'

const region = REGIONS[process.argv[2] ?? 'intl']
const model = process.argv[3] ?? 'step-5-preview'

const ctx = {
  logger: { info: () => {}, warn: (...args) => console.warn('[warn]', ...args), error: console.error },
  credentials: {
    resolve: async (ref) => {
      const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(`${home}/.credentials.yaml`, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}

const token = await readToken(ctx, region)
const catalog = await fetchModelEntries(ctx, region)
const entry = catalog.entries.find((candidate) => candidate.id === model)
const levels = entry?.efforts === undefined ? [] : Object.keys(entry.efforts)
console.log(`${region.id} / ${model}`)
console.log(`  目录档位: ${levels.join(', ') || '(无)'}  默认 ${entry?.defaultEffort ?? '(无)'}  费率 ${entry?.credits ?? '(无)'}`)

const route = chatRoutes(region)[0]
const prompt = '笼子里有鸡和兔共 20 只，脚一共 56 只。鸡和兔各几只？只回答两个数字。'

async function send(label, extra) {
  const conversation = randomUUID()
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt }
    ],
    stream: true,
    prompt_cache_key: conversation,
    max_tokens: 512,
    ...extra
  }
  // `undefined` in a variant means "drop this field", which is how the
  // max_completion_tokens shape is expressed.
  for (const [key, value] of Object.entries(body)) if (value === undefined) delete body[key]
  const started = Date.now()
  const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Domain': route.apiDomain,
      'X-Product': 'SaaS',
      'X-Product-Code': route.productCode,
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': route.ideName,
      'X-IDE-Type': route.ideName,
      'X-IDE-Version': route.ideVersion,
      'User-Agent': route.userAgent,
      'X-Conversation-ID': conversation,
      'X-Conversation-Message-ID': randomUUID(),
      'X-Conversation-Request-ID': randomUUID()
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let code = ''
    try { const parsed = JSON.parse(text); code = `${parsed.code ?? ''} ${parsed.msg ?? ''}`.trim() } catch { code = text.slice(0, 90) }
    return { label, status: response.status, code, ms: Date.now() - started, extra: JSON.stringify(extra) }
  }

  let reasoning = ''
  let answer = ''
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data.length === 0 || data === '[DONE]') continue
      let frame
      try { frame = JSON.parse(data) } catch { continue }
      const delta = frame.choices?.[0]?.delta ?? {}
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (typeof delta.content === 'string') answer += delta.content
    }
  }
  return { label, status: response.status, code: 'ok', reasoning: reasoning.length, answer: answer.trim().slice(0, 40), ms: Date.now() - started, extra: JSON.stringify(extra) }
}

const variants = [
  ['基线（适配器当前对该模型发的形状）', {}],
  ['+ thinking:{type:"enabled"}', { thinking: { type: 'enabled' } }],
  ['+ thinking:{type:"disabled"}', { thinking: { type: 'disabled' } }],
  ['+ thinking:{type:"nonsense"}', { thinking: { type: 'nonsense' } }],
  ...(levels.length > 0 ? [[`+ reasoning_effort:"${levels.at(-1)}"`, { reasoning_effort: levels.at(-1) }]] : []),
  ['+ reasoning_effort:"totally-bogus"', { reasoning_effort: 'totally-bogus' }],
  // Vendor-specific spellings: OpenAI's newer APIs take `max_completion_tokens`
  // where everyone else takes `max_tokens`, and Zhipu documents `do_sample`.
  // Whether the gateway normalises them, forwards them, or rejects them is
  // exactly what this probe is for.
  ['+ max_completion_tokens:512（去掉 max_tokens）', { max_tokens: undefined, max_completion_tokens: 512 }],
  ['+ 未知字段 wb_probe:1', { wb_probe: 1 }]
]

console.log('')
const results = []
for (const [label, extra] of variants) {
  process.stdout.write(`  ${label.padEnd(38)} … `)
  const result = await send(label, extra)
  results.push(result)
  console.log(result.status === 200
    ? `200 思考 ${String(result.reasoning ?? 0).padStart(5)} 字 / 答「${result.answer ?? ''}」/ ${result.ms}ms`
    : `${result.status} ${result.code}`)
}

console.log('\n形状'.padEnd(40), 'HTTP', '业务码 / 说明')
for (const result of results) console.log(result.label.padEnd(40), String(result.status).padEnd(5), result.code)
console.log('\n请求体附加字段:', results.map((result) => `${result.label} → ${result.extra}`).join('\n  '))
