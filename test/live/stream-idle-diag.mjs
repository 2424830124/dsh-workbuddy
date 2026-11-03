/**
 * Dev probe: watch the raw byte timing of a streaming answer.
 *
 * The "answers one token then hangs" report needs a distinction the adapter hides:
 * whether the socket went quiet (upstream stopped producing) or the client stopped
 * asking. This probe wraps `fetch`, so it logs every `read()` the adapter performs —
 * gap since the previous read, byte count, and a preview of what arrived — plus the
 * response status and headers. A stalled round shows up as a large gap followed by
 * nothing at all, and the trailing bytes say how far upstream had got.
 *
 * Cost: the China deployment spends a few tokens per round; nothing is probed for
 * free here because the whole point is a real generation.
 *
 * Run: `node test/live/stream-idle-diag.mjs [cn|intl] [rounds] [modelId] [--long] [--filler N]`
 *   --long      ask for an 800-character answer (long generation, more silence risk)
 *   --filler N  prepend N characters of filler to the prompt (long context, ~0.55 token/char)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { readToken } from '../../src/account/auth.js'
import { REGIONS } from '../../src/core/regions.js'

const region = REGIONS[process.argv[2] ?? 'cn']
const count = Number(process.argv[3] ?? 3)
const model = process.argv[4] ?? 'deepseek-v4.1-flash'
const longAnswer = process.argv.includes('--long')
const fillerAt = process.argv.indexOf('--filler')
const fillerSize = fillerAt >= 0 ? Number(process.argv[fillerAt + 1] ?? 0) : 0
const SILENT_ALARM_MS = 15_000

const lines = []
const ctx = {
  logger: {
    info: (...args) => lines.push(args.join(' ')),
    warn: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' '))
  },
  credentials: {
    resolve: async (ref) => {
      const path = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(path, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  },
  get: () => undefined
}

const token = await readToken(ctx, region)
if (token === undefined || token.length === 0) {
  console.log(`${region.id}: 没有可用令牌，先 /workbuddy login ${region.id}`)
  process.exit(0)
}

const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

const filler = fillerSize > 0
  ? `${'这里是一段用于撑大上下文的填充文本，不包含任何需要回答的问题。'.repeat(Math.ceil(fillerSize / 27)).slice(0, fillerSize)}\n\n`
  : ''
const prompt = `${filler}${longAnswer ? '请写一篇 800 字的技术短文，主题是"流式接口的边界情况"，分段输出，不要省略。' : '1+1=? 只回答数字'}`
const system = longAnswer ? '你是一个严谨的技术作者。' : 'You are a calculator. Answer with a single digit.'

const realFetch = globalThis.fetch
let current = undefined

globalThis.fetch = async (url, init) => {
  const started = Date.now()
  const response = await realFetch(url, init)
  const interesting = ['content-type', 'transfer-encoding', 'content-length', 'content-encoding', 'x-request-id', 'server', 'x-accel-buffering']
    .map((name) => [name, response.headers.get(name)]).filter(([, value]) => value !== null)
  console.log(`  HTTP ${response.status} ${Date.now() - started}ms  ${interesting.map(([name, value]) => `${name}=${value}`).join('  ')}`)
  const state = { lastAt: Date.now(), bytes: 0, reads: 0, maxGap: 0, lastPreview: '', sawReasoning: 0, sawContent: 0, alarms: 0, status: response.status, errorBody: '' }
  current = state
  if (response.body === null) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      const now = Date.now()
      const gap = now - state.lastAt
      state.lastAt = now
      state.maxGap = Math.max(state.maxGap, gap)
      if (done) {
        console.log(`  EOF（最后一段之后 ${gap}ms，共 ${state.reads} 次读取 / ${state.bytes} 字节）`)
        controller.close()
        return
      }
      state.reads += 1
      state.bytes += value.length
      const text = decoder.decode(value, { stream: true })
      if (state.status >= 400) state.errorBody += text
      if (text.includes('"reasoning_content"')) state.sawReasoning += 1
      if (text.includes('"content"')) state.sawContent += 1
      if (text.trim().length > 0) state.lastPreview = text.replace(/\s+/g, ' ').slice(-160)
      const alarm = gap > SILENT_ALARM_MS ? `  ⚠ 静默 ${gap}ms` : ''
      if (alarm.length > 0) state.alarms += 1
      console.log(`  +${String(gap).padStart(5)}ms ${String(value.length).padStart(6)}B  ${text.replace(/\s+/g, ' ').slice(0, 110)}${alarm}`)
      controller.enqueue(value)
    }
  })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}

const rows = []
for (let index = 1; index <= count; index += 1) {
  lines.length = 0
  console.log(`\n=== 第 ${index}/${count} 次：${region.id} / ${model}${longAnswer ? '（长回答）' : ''}${fillerSize > 0 ? `（填充 ${fillerSize} 字）` : ''}`)
  const started = Date.now()
  let finish
  let text = ''
  let failure
  try {
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: longAnswer ? 4000 : 256,
      signal: AbortSignal.timeout(240_000)
    })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    failure = error
  }
  const ms = Date.now() - started
  const kind = failure !== undefined ? '抛错' : (finish?.kind ?? '(没有 finish)')
  rows.push({
    index,
    kind,
    code: failure?.code ?? finish?.failure?.code ?? '',
    ms,
    textChars: text.length,
    reasoningReads: current?.sawReasoning ?? 0,
    contentReads: current?.sawContent ?? 0,
    maxGap: current?.maxGap ?? 0,
    alarms: current?.alarms ?? 0,
    lastPreview: current?.lastPreview ?? ''
  })
  const row = rows.at(-1)
  console.log(`  → ${kind}${row.code.length > 0 ? ` (${row.code})` : ''}  ${ms}ms  正文 ${row.textChars} 字  最长静默 ${row.maxGap}ms  读取中见到 reasoning ${row.reasoningReads} 次 / content ${row.contentReads} 次`)
  if ((current?.errorBody ?? '').length > 0) console.log(`  → 非 2xx 报文：${current.errorBody.replace(/\s+/g, ' ').slice(0, 600)}`)
  if (row.alarms > 0) console.log(`  → 有 ${row.alarms} 次读取间隔超过 ${SILENT_ALARM_MS}ms；最后一次到达的字节：「${row.lastPreview}」`)
  if (lines.length > 0) for (const line of lines.slice(-4)) console.log(`  日志: ${line.slice(0, 200)}`)
}

console.log(`\n=== 汇总：${region.id} / ${model}，${count} 次`)
for (const row of rows) {
  console.log(`  ${String(row.index).padStart(2)}. ${row.kind}${row.code.length > 0 ? ` (${row.code})` : ''}  ${String(row.ms).padStart(7)}ms  正文 ${String(row.textChars).padStart(4)} 字  最长静默 ${String(row.maxGap).padStart(6)}ms`)
}
const silent = rows.filter((row) => row.alarms > 0).length
console.log(`  静默超过 ${SILENT_ALARM_MS}ms 的次数：${silent}/${count}`)
