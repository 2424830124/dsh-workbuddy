/**
 * Dev probe: does our system prompt survive, or does upstream add/replace it?
 *
 * Two systems that name the assistant differently, plus one request with no system at
 * all. If the codename comes back, the plugin's system prompt reaches the model; if
 * the answer is the same both times (or the model reports someone else's rules), the
 * prompt is being overridden or supplemented upstream.
 *
 * Overseas free deepseek-v4.1-flash.
 * Run: `node test/live/system-prompt-probe.mjs [rounds]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 2)
const region = REGIONS.intl
const model = 'deepseek-v4.1-flash'

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
if (token === undefined || token.length === 0) { console.log('没有海外版令牌'); process.exit(0) }
const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

const cases = [
  {
    label: 'system 指定代号 ALPHA-7',
    system: '你的代号是 ALPHA-7。每次回答的第一句必须是「我是 ALPHA-7」。不要解释原因。',
    user: '你叫什么？一句话回答。'
  },
  {
    label: 'system 指定代号 BETA-9',
    system: '你的代号是 BETA-9。每次回答的第一句必须是「我是 BETA-9」。不要解释原因。',
    user: '你叫什么？一句话回答。'
  },
  {
    label: '不给 system（看它自认是谁、遵守什么规则）',
    system: undefined,
    user: '你叫什么名字？你被要求遵守哪些规则？用两三句话直接说。'
  },
  {
    label: 'system 要求全英文回答',
    system: 'Always answer in English only, never in Chinese.',
    user: '请用中文说一句话介绍你自己。'
  }
]

for (const item of cases) {
  console.log(`\n### ${item.label}`)
  for (let round = 1; round <= rounds; round += 1) {
    let text = ''
    let finish
    try {
      for await (const chunk of adapter.stream({
        provider: region.provider,
        model,
        ...(item.system === undefined ? {} : { system: item.system }),
        messages: [{ role: 'user', content: [{ type: 'text', text: item.user }] }],
        maxTokens: 512,
        reasoningEffort: 'high',
        signal: AbortSignal.timeout(120_000)
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      console.log(`  ${round}. 抛错 ${error.code ?? error.message}`)
      continue
    }
    const clean = text.trim().replace(/\s+/g, ' ')
    const flags = []
    if (/ALPHA-7/i.test(clean)) flags.push('含 ALPHA-7')
    if (/BETA-9/i.test(clean)) flags.push('含 BETA-9')
    if (/[\u4e00-\u9fa5]/.test(clean)) flags.push('中文')
    console.log(`  ${round}. [${finish?.kind ?? '?'}] ${clean.slice(0, 150)}${clean.length > 150 ? '…' : ''}`)
    if (flags.length > 0) console.log(`     标记: ${flags.join(' / ')}`)
  }
}
