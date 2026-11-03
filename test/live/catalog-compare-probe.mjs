/**
 * Dev probe: compare the two deployments' model catalogs field by field, so
 * "does China have X too?" has a measured answer. Prints, per deployment and
 * per field, how many models carry it plus a sample value.
 *
 * Run: `node test/live/catalog-compare-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const text = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(text)
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}

const sources = [
  {
    id: 'CN scoped',
    url: 'https://www.workbuddy.cn/console/enterprises/personal/models',
    domain: 'www.workbuddy.cn',
    ua: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
    token: tokenOf('WORKBUDDY_CN_TOKEN'),
    pick: (json) => json?.data?.models
  },
  {
    id: 'INTL /v3/config',
    url: 'https://www.workbuddy.ai/v3/config',
    domain: 'www.workbuddy.ai',
    ua: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    token: tokenOf('WORKBUDDY_INTL_TOKEN'),
    pick: (json) => json?.data?.models
  },
  {
    id: 'CN /v3/config',
    url: 'https://www.workbuddy.cn/v3/config',
    domain: 'www.workbuddy.cn',
    ua: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
    token: tokenOf('WORKBUDDY_CN_TOKEN'),
    pick: (json) => json?.data?.models
  },
  {
    id: 'INTL scoped',
    url: 'https://www.workbuddy.ai/console/enterprises/personal/models',
    domain: 'www.workbuddy.ai',
    ua: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    token: tokenOf('WORKBUDDY_INTL_TOKEN'),
    pick: (json) => json?.data?.models
  }
]

const FIELDS = [
  'name', 'descriptionZh', 'descriptionEn', 'summary', 'credits', 'tags',
  'reasoning', 'supportsImages', 'supportsReasoning', 'supportsToolCall',
  'onlyReasoning', 'canDisableThinking', 'disabledMultimodal',
  'contextWindow', 'maxInputTokens', 'maxOutputTokens', 'maxAllowedSize',
  'isDefault', 'vendor', 'relatedModels', 'iconUrl', 'iconUrl_en',
  'temperature', 'top_p', 'top_k', 'repetition_penalty'
]

const results = []
for (const source of sources) {
  try {
    const response = await fetch(source.url, {
      headers: {
        Authorization: `Bearer ${source.token}`,
        Accept: 'application/json',
        'X-Domain': source.domain,
        'X-Product': 'SaaS',
        'X-Product-Code': 'workbuddy',
        'User-Agent': source.ua
      },
      signal: AbortSignal.timeout(30_000)
    })
    const body = await response.text()
    if (response.status !== 200) {
      results.push({ id: source.id, status: response.status, note: body.replace(/\s+/g, ' ').slice(0, 90) })
      continue
    }
    const models = source.pick(JSON.parse(body)) ?? []
    const coverage = {}
    for (const field of FIELDS) {
      const present = models.filter((model) => {
        const value = model?.[field]
        return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)
      })
      coverage[field] = `${present.length}/${models.length}${present.length > 0 ? ` e.g. ${JSON.stringify(present[0][field]).slice(0, 46)}` : ''}`
    }
    results.push({ id: source.id, status: response.status, models, coverage })
  } catch (error) {
    results.push({ id: source.id, error: String(error).slice(0, 110) })
  }
}

const has = (model, field) => {
  const value = model?.[field]
  return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)
}

for (const result of results) {
  console.log(`\n=== ${result.id} ===`)
  if (result.error !== undefined || result.coverage === undefined) {
    console.log(JSON.stringify(result))
    continue
  }
  console.log(`models: ${result.models.length}`)
  for (const field of FIELDS) console.log(`  ${field.padEnd(20)} ${result.coverage[field]}`)
  const noDescription = result.models.filter((model) => !has(model, 'descriptionZh'))
  console.log(`  -- 无 descriptionZh 的 ${noDescription.length} 个: ${noDescription.map((model) => model.id).join(', ')}`)
  const noCredits = result.models.filter((model) => !has(model, 'credits'))
  console.log(`  -- 无 credits 的 ${noCredits.length} 个: ${noCredits.map((model) => model.id).join(', ')}`)
  const noEfforts = result.models.filter((model) => !has(model, 'reasoning') || !has(model.reasoning, 'supportedEfforts'))
  console.log(`  -- reasoning 里没有 supportedEfforts 的 ${noEfforts.length} 个: ${noEfforts.map((model) => model.id).join(', ')}`)
}
