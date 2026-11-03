/**
 * Dev probe: what does one probe request cost, to the precision the billing
 * endpoint reports?
 *
 * Runs the same probe N times against a *paid* usable model on each deployment
 * and prints the precise credit delta, so "an empty system message still costs
 * the role's template tokens" can be a number instead of a guess.
 *
 * Run: `node test/live/probe-cost-precise.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { probeBody } from '../../src/catalog/availability.js'
import { chatRoutes, REGIONS } from '../../src/core/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const yaml = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(yaml)
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}

async function balance(region) {
  const route = chatRoutes(region)[0]
  const response = await fetch(`${route.endpoint}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenOf(region.tokenRef)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Domain': route.apiDomain,
      'X-Product': 'SaaS',
      'X-Product-Code': route.productCode,
      'User-Agent': route.userAgent
    },
    body: '{}',
    signal: AbortSignal.timeout(20_000)
  })
  const json = await response.json()
  const packs = json?.data?.Response?.Data?.Accounts ?? []
  let precise = 0
  let loose = 0
  for (const pack of packs) {
    if (pack.Status === 3) continue
    const p = Number.parseFloat(String(pack.cycleCapacityRemainPrecise ?? ''))
    const l = Number.parseFloat(String(pack.CycleCapacityRemain ?? ''))
    if (Number.isFinite(p)) precise += p
    if (Number.isFinite(l)) loose += l
  }
  return { precise, loose, packs: packs.length, sample: packs[0] }
}

async function probeOnce(region, model) {
  const route = chatRoutes(region)[0]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25_000)
  try {
    const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenOf(region.tokenRef)}`,
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
        'X-Conversation-ID': crypto.randomUUID().replace(/-/g, ''),
        'X-Conversation-Message-ID': crypto.randomUUID(),
        'X-Conversation-Request-ID': crypto.randomUUID()
      },
      body: JSON.stringify(probeBody(region, model)),
      signal: controller.signal
    })
    const text = response.status === 200 ? '' : await response.text()
    if (response.status === 200) await response.body?.cancel().catch(() => {})
    return { status: response.status, code: /"code":(\d+)/.exec(text)?.[1] ?? '-' }
  } finally {
    clearTimeout(timer)
  }
}

const first = await balance(REGIONS.cn)
console.log('计费样本字段:', JSON.stringify(first.sample)?.slice(0, 500))

const rounds = Number.parseInt(process.argv[2] ?? '8', 10)
for (const [region, model] of [[REGIONS.cn, 'glm-5.3'], [REGIONS.intl, 'kimi-k3'], [REGIONS.intl, 'hy3']]) {
  const before = await balance(region)
  const codes = []
  for (let index = 0; index < rounds; index += 1) {
    const result = await probeOnce(region, model)
    codes.push(`${result.status}/${result.code}`)
  }
  // Let the meter settle before reading it again.
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const after = await balance(region)
  const delta = after.precise - before.precise
  console.log(`\n${region.id} · ${model} · ${rounds} 次 · 形态 ${JSON.stringify(probeBody(region, model))}`)
  console.log(`  响应: ${[...new Set(codes)].join(' ')}`)
  console.log(`  精确余额 ${before.precise} → ${after.precise}  差值 ${delta.toFixed(6)}  每次 ${(delta / rounds).toFixed(6)}`)
  console.log(`  整数余额 ${before.loose} → ${after.loose}`)
}
