/**
 * Dev probe: is the early stop a sampling problem?
 *
 * `stop` is the model sampling its end-of-sequence token, so a hot default can end
 * a turn right after "现在我来改……：" instead of calling the tool. This runs the same
 * tool-using prompt at several temperatures and counts how often the answer ends
 * without the call.
 *
 * Run: `node test/live/sampling-probe.mjs [cn|intl] [rounds] [modelId]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const region = REGIONS[process.argv[2] ?? 'intl']
const rounds = Number(process.argv[3] ?? 4)
const model = process.argv[4] ?? 'deepseek-v4.1-flash'

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
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
if (token === undefined || token.length === 0) { console.log('没有令牌，先登录'); process.exit(0) }

const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

// The same shape of turn that failed in the real session: a code change asked for,
// one tool offered, so the only acceptable ending is a tool call.
const tools = [{
  name: 'write',
  description: 'Write a file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['file_path', 'content']
  }
}]
const messages = [{
  role: 'user',
  content: [{
    type: 'text',
    text: '请把 E:\\Projects\\demo\\src\\index.js 里的 console.log("a") 改成 console.log("b")。直接用 write 工具改，不要解释。'
  }]
}]

const temperatures = [undefined, 0.2, 0.5, 1.0]
const results = []

for (const temperature of temperatures) {
  const row = { temperature, stop: 0, toolCalls: 0, error: 0, other: 0, samples: [] }
  for (let round = 1; round <= rounds; round += 1) {
    let finish
    let text = ''
    let reasoning = ''
    let calls = 0
    try {
      for await (const chunk of adapter.stream({
        provider: region.provider,
        model,
        system: '你是一个动手型的编程助手：需要改文件时直接调用工具，不要先叙述。',
        messages,
        tools,
        maxTokens: 2048,
        ...(temperature === undefined ? {} : { temperature }),
        signal: AbortSignal.timeout(120_000)
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? ''
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls += 1
        if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      row.error += 1
      row.samples.push(`抛错:${error.code ?? error.message}`)
      continue
    }
    const kind = finish?.kind ?? '(无)'
    if (kind === 'tool-calls' || calls > 0) row.toolCalls += 1
    else if (kind === 'stop') row.stop += 1
    else row.other += 1
    row.samples.push(`${kind}${calls > 0 ? '+call' : ''} 正文${text.length}字 思考${reasoning.length}字`)
  }
  results.push(row)
  const label = temperature === undefined ? '默认(不发)' : `t=${temperature}`
  console.log(`${label.padEnd(12)} 工具调用 ${row.toolCalls}/${rounds}  提前stop ${row.stop}/${rounds}  其它 ${row.other}  错误 ${row.error}`)
  console.log(`   ${row.samples.join(' | ')}`)
}

console.log('\n=== 汇总（提前 stop = 该调用工具却只说了话）===')
for (const row of results) {
  const label = row.temperature === undefined ? '默认(不发 temperature)' : `temperature=${row.temperature}`
  console.log(`  ${label.padEnd(26)} 提前 stop ${row.stop}/${rounds}（${Math.round(row.stop / rounds * 100)}%）`)
}
console.log('\n提示：若默认档明显更差，说明上游默认采样偏热；可用温度/档位缓解（见协议文档 §4.5）')
