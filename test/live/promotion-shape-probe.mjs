/**
 * Dev probe: what does a promotion look like in the payloads, and how does a
 * model reference one? The panel needs to show it in a model's details.
 *
 * Run: `node test/live/promotion-shape-probe.mjs`
 */

import { REGIONS } from '../../src/core/regions.js'

for (const region of [REGIONS.intl, REGIONS.cn]) {
  const response = await fetch(`${region.endpoint}/v3/config`, {
    headers: {
      Authorization: `Bearer ${tokenOf(region.tokenRef)}`,
      Accept: 'application/json',
      'X-Domain': region.apiDomain,
      'X-Product': 'SaaS',
      'X-Product-Code': 'workbuddy',
      'User-Agent': region.userAgent
    },
    signal: AbortSignal.timeout(25_000)
  })
  const data = (await response.json())?.data ?? {}
  console.log(`\n=== ${region.id} ===`)
  console.log('modelPromotions:', JSON.stringify(data.modelPromotions)?.slice(0, 900))
  const models = data.models ?? []
  const withPromo = models.filter((model) => JSON.stringify(model).match(/promot/i) !== null)
  console.log(`模型里带 promot* 字段的: ${withPromo.length} 个`)
  for (const model of withPromo.slice(0, 4)) {
    console.log(`  ${model.id}: ${JSON.stringify(Object.fromEntries(Object.entries(model).filter(([key]) => /promot/i.test(key))))}`.slice(0, 320))
  }
  const productPromo = data.productFeatures?.modelPromotions ?? data.productFeaturesConfig?.modelPromotions
  if (productPromo !== undefined) console.log('productFeatures.modelPromotions:', JSON.stringify(productPromo).slice(0, 400))
}
