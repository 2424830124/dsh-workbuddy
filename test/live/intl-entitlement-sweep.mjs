/**
 * Dev probe: sweep the international catalog with a *minimal valid* request
 * (`max_tokens: 1`, cancelled as soon as the status is known), because every
 * invalid shape is rejected there before the checks we need.
 *
 * Reports each model's verdict (usable / not allowed for this user type /
 * gone) and measures the credits delta around the whole sweep, so the cost of
 * this probe shape is a measurement rather than a guess.
 *
 * Run: `node test/live/intl-entitlement-sweep.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { REGIONS } from '../../src/core/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const text = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(text)
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}
const region = REGIONS.intl
const token = tokenOf('WORKBUDDY_INTL_TOKEN')

const headers = () => ({
  Authorization: `Bearer ${token}`,
  Accept: 'text/event-stream',
  'Content-Type': 'application/json',
  'X-Domain': region.apiDomain,
  'X-Product': 'SaaS',
  'X-Product-Code': 'workbuddy',
  'X-Agent-Purpose': 'conversation',
  'X-IDE-Name': 'WorkBuddy',
  'X-IDE-Type': 'WorkBuddy',
  'X-IDE-Version': region.version,
  'User-Agent': region.userAgent,
  'X-Conversation-ID': crypto.randomUUID().replace(/-/g, ''),
  'X-Conversation-Message-ID': crypto.randomUUID(),
  'X-Conversation-Request-ID': crypto.randomUUID()
})

async function credits() {
  const response = await fetch(`${region.endpoint}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: { ...headers(), Accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(20_000)
  })
  const json = await response.json()
  let total = 0
  for (const pack of json?.data?.Response?.Data?.Accounts ?? []) {
    if (pack.Status === 3) continue
    const value = pack.cycleCapacityRemainPrecise ?? pack.CycleCapacityRemain
    const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
    if (typeof parsed === 'number' && Number.isFinite(parsed)) total += parsed
  }
  return total
}

async function probe(model) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`${region.endpoint}/v2/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: '1' }],
        stream: true,
        max_tokens: 1
      }),
      signal: controller.signal
    })
    if (response.status === 200) {
      await response.body?.cancel().catch(() => {})
      return { state: 'ok', detail: '可用' }
    }
    const body = await response.text()
    const code = /"code":(\d+)/.exec(body)?.[1] ?? '-'
    const msg = /"(?:msg|error_description)":"([^"]{0,70})/.exec(body)?.[1] ?? ''
    if (code === '11158') return { state: 'denied', detail: `账号无权限（11158 ${msg}）` }
    if (code === '11102') return { state: 'dead', detail: '模型不存在（11102）' }
    return { state: 'other', detail: `${response.status}/${code} ${msg}` }
  } catch (error) {
    return { state: 'error', detail: String(error).slice(0, 50) }
  } finally {
    clearTimeout(timer)
  }
}

const catalog = await fetch(`${region.endpoint}/v3/config`, { headers: { ...headers(), Accept: 'application/json' } })
  .then((response) => response.json())
  .then((json) => json?.data?.models ?? [])
const ids = catalog.map((model) => model.id).filter((id) => !['default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model'].includes(id))
console.log(`INTL 目录（去预设）: ${ids.length} 个`)

const before = await credits()
const rows = []
for (const id of ids) {
  const verdict = await probe(id)
  rows.push({ id, ...verdict })
  console.log(`  ${id.padEnd(24)} ${verdict.state.padEnd(8)} ${verdict.detail}`)
}
const after = await credits()

const counts = new Map()
for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
console.log('\n统计:', JSON.stringify(Object.fromEntries(counts)))
console.log(`积分 ${before.toFixed(2)} → ${after.toFixed(2)}  差值 ${(after - before).toFixed(2)}`)
