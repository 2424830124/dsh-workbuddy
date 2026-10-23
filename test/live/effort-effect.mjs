/**
 * Dev probe: does `reasoning_effort` actually change how much the model thinks?
 *
 * It sends the *same* prompt once per effort level, using the adapter's own
 * request shape (same route, same headers, same body fields), and reports what
 * came back: the reasoning text, the answer, token usage, and how long it took.
 * A parameter the gateway ignores shows up as identical numbers across levels.
 *
 * Run: `node test/live/effort-effect.mjs [region] [model] [effort …]`
 *   node test/live/effort-effect.mjs intl deepseek-v4.1-flash
 *   node test/live/effort-effect.mjs cn glm-5.2 low high max
 *   ROUNDS=3 node test/live/effort-effect.mjs intl deepseek-v4.1-flash
 *
 * Reasoning volume is noisy, so one sample per level proves nothing; ROUNDS
 * repeats the whole ladder and the summary compares the per-level spread.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/account/auth.js'
import { fetchModelEntries } from '../../src/catalog/catalog.js'
import { chatRoutes, REGIONS } from '../../src/core/regions.js'

const region = REGIONS[process.argv[2] ?? 'intl']
const model = process.argv[3] ?? 'deepseek-v4.1-flash'
const requested = process.argv.slice(4)

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
if (token === undefined || token.length === 0) {
  console.log(`${region.id}: 没有令牌，先 /workbuddy login ${region.id}`)
  process.exit(0)
}

const catalog = await fetchModelEntries(ctx, region)
const entry = catalog.entries.find((candidate) => candidate.id === model)
const declared = entry?.efforts === undefined ? [] : Object.keys(entry.efforts)
const levels = requested.length > 0 ? requested : (declared.length > 0 ? declared : ['low', 'high', 'max'])
console.log(`${region.id} / ${model}`)
console.log(`  目录声明档位: ${declared.join(', ') || '(无)'}，默认 ${entry?.defaultEffort ?? '(无)'}`)
console.log(`  目录里的速率: ${entry?.credits ?? '(无)'}`)
console.log(`  本次测试档位: ${levels.join(', ')}\n`)

const route = chatRoutes(region)[0]
// A prompt can be overridden because reasoning volume is noisy: a task that
// *needs* several steps separates the levels better than a one-liner.
const prompt = process.env.PROMPT ?? '笼子里有鸡和兔共 20 只，脚一共 56 只。鸡和兔各几只？只回答两个数字，用逗号隔开。'

// One request with a value the catalog never declares: if the gateway answers
// 200, it does not validate the field at all, which is strong evidence that the
// field is ignored rather than merely weak.
if (process.env.SANITY === '1') {
  process.stdout.write('非法档位 reasoning_effort="totally-bogus" … ')
  const bogus = await call('totally-bogus')
  console.log(bogus.error === undefined
    ? `HTTP ${bogus.status} 正常返回（${bogus.reasoningChars} 字思考）→ 网关不校验该字段`
    : `HTTP ${bogus.status} 被拒 → 网关会校验该字段`)
  if (bogus.error !== undefined) console.log('  拒绝内容:', bogus.error)
  console.log()
}

/** One streaming call; returns everything the probe needs to compare. */
async function call(effort) {
  const conversation = randomUUID()
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt }
    ],
    stream: true,
    prompt_cache_key: conversation,
    max_tokens: 2048
  }
  if (effort !== undefined) body.reasoning_effort = effort

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
    return { effort, status: response.status, error: text.slice(0, 240), ms: Date.now() - started }
  }

  let reasoning = ''
  let answer = ''
  let usage
  let firstReasoningAt
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
      const delta = frame.choices?.[0]?.delta ?? frame.delta ?? {}
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        if (firstReasoningAt === undefined) firstReasoningAt = Date.now() - started
        reasoning += delta.reasoning_content
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) answer += delta.content
      if (frame.usage !== undefined) usage = frame.usage
    }
  }

  return {
    effort,
    status: response.status,
    reasoningChars: reasoning.length,
    reasoningPreview: reasoning.slice(0, 70).replace(/\s+/g, ' '),
    answer: answer.trim().slice(0, 60),
    firstReasoningAt,
    usage,
    ms: Date.now() - started
  }
}

const results = []
const rounds = Math.max(1, Number.parseInt(process.env.ROUNDS ?? '1', 10) || 1)
for (let round = 1; round <= rounds; round += 1) {
  if (rounds > 1) console.log(`— 第 ${round}/${rounds} 轮 —`)
  for (const effort of levels) {
    process.stdout.write(`  跑 ${String(effort).padEnd(6)} … `)
    const result = await call(effort)
    result.round = round
    results.push(result)
    if (result.error !== undefined) console.log(`HTTP ${result.status} — ${result.error}`)
    else console.log(`${result.reasoningChars} 字思考 / 回答「${result.answer}」/ ${result.ms}ms`)
  }
}

console.log('\n档位'.padEnd(10), '状态', ' 思考字数', ' completion', ' reasoning', ' 首字思考', ' 总耗时')
for (const result of results) {
  if (result.error !== undefined) { console.log(String(result.effort).padEnd(10), 'ERR ', result.status); continue }
  const completion = result.usage?.completion_tokens ?? '—'
  const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens ?? '—'
  console.log(
    `${String(result.effort).padEnd(8)}r${result.round}`,
    String(result.status).padEnd(5),
    String(result.reasoningChars).padStart(8),
    String(completion).padStart(11),
    String(reasoningTokens).padStart(10),
    String(result.firstReasoningAt ?? '—').padStart(9),
    String(result.ms).padStart(8)
  )
}

// Per-level summary: the interesting number is whether the levels separate.
const ok = results.filter((result) => result.error === undefined)
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
console.log('\n档位'.padEnd(10), '次数', '思考字数(均值)', '范围', 'completion 均值', '耗时均值')
for (const level of levels) {
  const rows = ok.filter((result) => result.effort === level)
  if (rows.length === 0) continue
  const chars = rows.map((row) => row.reasoningChars)
  const tokens = rows.map((row) => row.usage?.completion_tokens).filter((value) => typeof value === 'number')
  console.log(
    String(level).padEnd(10),
    String(rows.length).padStart(4),
    String(Math.round(mean(chars))).padStart(14),
    `${Math.min(...chars)}–${Math.max(...chars)}`.padStart(10),
    String(tokens.length === 0 ? '—' : Math.round(mean(tokens))).padStart(15),
    String(Math.round(mean(rows.map((row) => row.ms)))).padStart(9)
  )
}

// Verdict: levels must separate, and each level's own spread must not swallow
// the gap between levels.
const perLevel = levels
  .map((level) => ({ level, chars: ok.filter((row) => row.effort === level).map((row) => row.reasoningChars) }))
  .filter((row) => row.chars.length > 0)
const levelMeans = perLevel.map((row) => mean(row.chars))
const widestSpread = Math.max(...perLevel.map((row) => Math.max(...row.chars) - Math.min(...row.chars)), 0)
const gap = levelMeans.length < 2 ? 0 : Math.max(...levelMeans) - Math.min(...levelMeans)
console.log(`\n档位均值: ${perLevel.map((row) => `${row.level}=${Math.round(mean(row.chars))}`).join('  ')}`)
console.log(`档位间差距: ${Math.round(gap)} 字；单档内波动: ${Math.round(widestSpread)} 字`)
console.log(gap > widestSpread
  ? '结论：档位间差距大于档位内波动 → reasoning_effort 确实生效'
  : '结论：档位间差距没有超过噪声 → 本模型上看不出 reasoning_effort 的效果（多跑几轮再判）')
const sample = ok.find((result) => result.usage !== undefined)
if (sample !== undefined) console.log('usage 原样:', JSON.stringify(sample.usage))
