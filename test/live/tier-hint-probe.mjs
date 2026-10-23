/**
 * Dev probe: can entitlement be read statically?
 *
 * China's `/v3/config` carries `modelTiers[].requiredUserType`; if the
 * international payload has the same block, the models a free account cannot
 * use could be identified without sending a single request.
 *
 * Run: `node test/live/tier-hint-probe.mjs`
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

for (const region of [REGIONS.cn, REGIONS.intl]) {
  const token = tokenOf(region.tokenRef)
  const response = await fetch(`${region.endpoint}/v3/config`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Domain': region.apiDomain,
      'X-Product': 'SaaS',
      'X-Product-Code': 'workbuddy',
      'User-Agent': region.userAgent
    },
    signal: AbortSignal.timeout(25_000)
  })
  if (response.status !== 200) {
    console.log(`\n=== ${region.id}: HTTP ${response.status}`)
    continue
  }
  const data = (await response.json())?.data ?? {}
  console.log(`\n=== ${region.id} ===`)
  const tiers = data.modelTiers
  if (Array.isArray(tiers) && tiers.length > 0) {
    for (const tier of tiers) {
      console.log(`  tier=${tier.tier ?? '?'} requiredUserType=${tier.requiredUserType ?? '-'} models=${(tier.modelIds ?? []).length}`)
      console.log(`     ${(tier.modelIds ?? []).join(', ')}`)
      if (tier.hover?.textZh) console.log(`     hover: ${tier.hover.textZh}`)
    }
  } else {
    console.log('  modelTiers: 无')
  }
  const cap = data.productFeaturesConfig?.ModelRateLimitCap
  if (cap !== undefined) console.log('  ModelRateLimitCap:', JSON.stringify(cap).slice(0, 200))
  console.log('  productFeaturesConfig keys:', Object.keys(data.productFeaturesConfig ?? {}).join(', ') || '(无)')
}
