/**
 * Dev probe: where can a live rate come from for a model the deployment list
 * does not carry (`gpt-5.3-codex` on the international build)?
 *
 * 1. Dump the whole `/v3/config` payload and look for the id anywhere (it may
 *    sit in a block the catalog parser ignores).
 * 2. Try single-model endpoints that might answer a rate.
 *
 * Run: `node test/live/rate-source-probe.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REGIONS, chatRoutes } from '../../src/core/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const token = (/^[ \t]*WORKBUDDY_INTL_TOKEN:[ \t]*(.+)$/m.exec(readFileSync(credentialsPath, 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
const region = REGIONS.intl
const [route] = chatRoutes(region)

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'X-Domain': region.apiDomain,
  'X-Product': 'SaaS',
  'X-Product-Code': 'workbuddy',
  'User-Agent': region.userAgent
}

// 1. The config payload, in full.
const response = await fetch(`${region.endpoint}/v3/config`, { headers, signal: AbortSignal.timeout(25_000) })
const text = await response.text()
const dump = join(tmpdir(), 'intl-config.json')
writeFileSync(dump, text)
console.log(`/v3/config HTTP ${response.status}, ${text.length} bytes → ${dump}`)
console.log('  含 codex:', text.includes('codex'), '| 含 5.3:', text.includes('5.3'))

let json = {}
try {
  json = JSON.parse(text)
} catch {
  console.log('  (not JSON)')
}
const data = json?.data ?? {}
console.log('  顶层键:', Object.keys(data).join(', '))
for (const [key, value] of Object.entries(data)) {
  if (!Array.isArray(value)) continue
  const ids = value.map((item) => item?.id).filter((id) => typeof id === 'string')
  if (ids.length > 0) console.log(`  ${key}: ${ids.length} 个 → ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ' …' : ''}`)
}

// Any nested array holding a rate?
const rateBlocks = []
const walk = (node, path) => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, path)
    return
  }
  if (typeof node !== 'object' || node === null) return
  if (typeof node.credits === 'string' || typeof node.credit === 'number') rateBlocks.push(`${path}${node.id === undefined ? '' : `[${node.id}]`}=${node.credits ?? node.credit}`)
  for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
}
walk(data, 'data')
console.log(`  带倍率的节点 ${rateBlocks.length} 个，示例: ${rateBlocks.slice(0, 5).join(' ')}`)
const named = rateBlocks.filter((line) => /codex|sol|terra|luna|astra|grok|gemini/i.test(line))
console.log('  其中 GPT/Grok/Gemini 类:', named.length)
for (const line of named.slice(0, 20)) console.log(`    ${line}`)

// 2. Candidate single-model sources.
const candidates = [
  `${region.endpoint}/v3/models/gpt-5.3-codex`,
  `${region.endpoint}/v3/models?ids=gpt-5.3-codex`,
  `${region.endpoint}/v2/plugin/models/gpt-5.3-codex`,
  `${region.endpoint}/console/enterprises/personal/models/gpt-5.3-codex`,
  `${region.endpoint}/v3/config?model=gpt-5.3-codex`
]
console.log('\n候选单模型端点:')
for (const url of candidates) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    const body = (await res.text()).replace(/\s+/g, ' ')
    console.log(`  ${res.status} ${url.replace(region.endpoint, '')} ${body.slice(0, 90)}`)
  } catch (error) {
    console.log(`  ERR ${url.replace(region.endpoint, '')} ${String(error).slice(0, 50)}`)
  }
}

// 3. The rate may be attached to a live request's usage block.
console.log('\n真实请求的用量块（max_tokens 2，立刻取消）:')
try {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  const chat = await fetch(`${route.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': route.ideName,
      'X-IDE-Type': route.ideName,
      'X-IDE-Version': route.ideVersion,
      'X-Conversation-ID': crypto.randomUUID().replace(/-/g, ''),
      'X-Conversation-Message-ID': crypto.randomUUID(),
      'X-Conversation-Request-ID': crypto.randomUUID()
    },
    body: JSON.stringify({
      model: 'gpt-5.3-codex',
      messages: [{ role: 'system', content: '.' }, { role: 'user', content: '1' }],
      stream: true,
      max_tokens: 2
    }),
    signal: controller.signal
  })
  let seen = ''
  const reader = chat.body?.getReader()
  const deadline = Date.now() + 8000
  while (reader !== undefined && Date.now() < deadline && seen.length < 4000) {
    const { value, done } = await reader.read()
    if (done === true) break
    seen += new TextDecoder().decode(value)
  }
  await reader?.cancel().catch(() => {})
  clearTimeout(timer)
  const usage = /"usage":\{[^}]*\}/.exec(seen)?.[0] ?? (seen.includes('usage') ? '有 usage 字段但未成形' : '无 usage 字段')
  const credit = /"(?:credit|credits|cost|price)[^,}]{0,40}/.exec(seen)?.[0] ?? '无 credit/cost 字段'
  console.log(`  HTTP ${chat.status} | ${usage} | ${credit}`)
  writeFileSync(join(tmpdir(), 'intl-codex-stream.txt'), seen)
} catch (error) {
  console.log(`  ERR ${String(error).slice(0, 60)}`)
}
