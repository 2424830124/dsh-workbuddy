/**
 * Dev probe: how often does an upstream response end without its terminator?
 *
 * A response is complete only when it carries `finish_reason` (and the SSE stream
 * reaches `[DONE]`) or delivers a tool call. Anything else is a cut connection —
 * the case that used to be reported as a clean `stop`, ending the turn silently.
 *
 * The probe drives the plugin's own adapter, so it measures exactly what the
 * harness would see, including the failure message the panel would show.
 *
 * Cost: the China deployment probes for free (see protocol §4.9); the overseas one
 * spends a token or two per run, so it needs an explicit `intl`.
 *
 * Run: `node test/live/stream-cut-probe.mjs [cn|intl] [count] [modelId]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const region = REGIONS[process.argv[2] ?? 'cn']
const count = Number(process.argv[3] ?? 5)
const model = process.argv[4] ?? 'deepseek-v4.1-flash'
const longAnswer = process.argv.includes('--long')
const selfTest = process.argv.includes('--selftest')

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
if (region.freeProbe !== true && process.argv[2] !== 'intl') {
  console.log(`${region.id}: 每次探测会有 token 消耗；本脚本默认只自动跑大陆版（零消耗）`)
}

const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

/**
 * Offline self-check: feed the adapter a truncated SSE body and confirm it is
 * classified as a retryable cut rather than a clean stop. Runs without network.
 */
if (selfTest) {
  const sse = 'data: {"choices":[{"delta":{"content":"我先想想"}}]}\n\n'
  globalThis.fetch = async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: region.provider,
    model,
    system: 'self test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: AbortSignal.timeout(5_000)
  })) chunks.push(chunk)
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  console.log('自检（离线、故意截断的流）:')
  console.log('  判定:', finish?.reason?.kind, '/', finish?.reason?.failure?.code)
  console.log('  消息:', finish?.reason?.failure?.message)
  const ok = finish?.reason?.kind === 'error' && finish?.reason?.failure?.code === 'TRANSPORT'
  console.log(ok ? '  ✓ 被正确判为可重试的传输中断' : '  ✗ 判定错误')
  process.exit(ok ? 0 : 1)
}

const prompt = longAnswer
  ? '请写一篇 800 字的技术短文，主题是"流式接口的边界情况"，分段输出，不要省略。'
  : `${1}+1=? 只回答数字`

const rows = []
for (let index = 1; index <= count; index += 1) {
  const started = Date.now()
  let finish
  let text = ''
  let failure
  try {
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system: longAnswer ? '你是一个严谨的技术作者。' : 'You are a calculator. Answer with a single digit.',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: longAnswer ? 4000 : 256,
      signal: AbortSignal.timeout(180_000)
    })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    failure = error
  }
  const ms = Date.now() - started
  const kind = failure !== undefined ? '抛错' : (finish?.kind ?? '(没有 finish)')
  const code = failure?.code ?? finish?.failure?.code ?? ''
  const detail = failure?.message ?? finish?.failure?.message ?? ''
  const cut = code === 'TRANSPORT'
  rows.push({ index, kind, code, ms, cut, detail, text: text.trim().slice(0, 20) })
  console.log(`${String(index).padStart(2)}. ${kind}${code.length > 0 ? ` (${code})` : ''}  ${String(ms).padStart(6)}ms  文本=${JSON.stringify(rows.at(-1).text)}`)
  if (detail.length > 0) console.log(`     ${detail.replace(/\s+/g, ' ').slice(0, 200)}`)
}

const cutCount = rows.filter((row) => row.cut).length
const kinds = new Map()
for (const row of rows) kinds.set(`${row.kind}${row.code.length > 0 ? ` (${row.code})` : ''}`, (kinds.get(`${row.kind}${row.code.length > 0 ? ` (${row.code})` : ''}`) ?? 0) + 1)
console.log(`\n=== ${region.id} / ${model} — ${count} 次${longAnswer ? '（长回答模式）' : ''}`)
for (const [kind, times] of kinds) console.log(`  ${times} × ${kind}`)
console.log(`  被掐断（TRANSPORT，自动重试）：${cutCount}/${count}`)
const durations = rows.map((row) => row.ms).sort((a, b) => a - b)
if (durations.length > 0) console.log(`  用时 中位数 ${durations[Math.floor(durations.length / 2)]}ms，最长 ${durations.at(-1)}ms`)

if (lines.length > 0) {
  console.log('\n适配器日志:')
  for (const line of lines.slice(-8)) console.log('  ' + line.slice(0, 200))
}
console.log('\n说明：被掐断的响应会以 TRANSPORT 上报，harness 默认策略会自动重试（最多 5 次，0.5s→10s 退避）')
