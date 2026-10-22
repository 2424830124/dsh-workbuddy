/** Which models are free right now, and which families do they belong to? */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const ctx = {
  logger: { info: () => {}, warn: console.warn, error: console.error },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(`${home}/.credentials.yaml`, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}

for (const region of [REGIONS.cn, REGIONS.intl]) {
  const token = await readToken(ctx, region)
  const url = region.id === 'cn'
    ? `https://${region.apiDomain}/console/enterprises/personal/models`
    : `https://${region.apiDomain}/v3/config`
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-domain': region.apiDomain,
      'x-product': 'SaaS',
      'x-product-code': 'workbuddy',
      'user-agent': region.userAgent
    }
  })
  const payload = await response.json()

  const records = []
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || typeof node !== 'object') return
    if (typeof node.id === 'string' && node.credits !== undefined) records.push(node)
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') walk(value)
  }
  walk(payload)

  const rateOf = (text) => {
    const match = /(\d+(?:\.\d+)?)/.exec(String(text ?? ''))
    return match === null ? undefined : Number(match[1])
  }

  console.log(`\n=== ${region.id} — ${records.length} 条带倍率的记录`)
  const free = records.filter((record) => rateOf(record.credits) === 0)
  console.log(`免费（0 倍）${free.length} 个：`)
  for (const record of free) {
    const levels = Array.isArray(record.reasoning?.supportedEfforts) ? record.reasoning.supportedEfforts.join('/') : '—'
    console.log(`  ${String(record.id).padEnd(24)} ${String(record.credits).padEnd(14)} 档位 ${levels.padEnd(16)} vendor=${record.vendor ?? '—'} 强制思考=${record.onlyReasoning ?? '—'}`)
  }
  const paid = records.filter((record) => (rateOf(record.credits) ?? 0) > 0)
  console.log(`非免费 ${paid.length} 个，最便宜的三档：`)
  for (const record of paid.sort((a, b) => rateOf(a.credits) - rateOf(b.credits)).slice(0, 3)) {
    const levels = Array.isArray(record.reasoning?.supportedEfforts) ? record.reasoning.supportedEfforts.join('/') : '—'
    console.log(`  ${String(record.id).padEnd(24)} ${String(record.credits).padEnd(14)} 档位 ${levels}`)
  }
}
