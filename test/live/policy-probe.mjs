/**
 * Dev probe: what the admission policy yields per deployment.
 *
 * Prints each deployment's own whitelist (`agents[].models` in its own payload —
 * the two are NOT the same list) and the final catalog after the policy, so a
 * rule change can be compared against what the web pickers show.
 *
 * Run: `node test/live/policy-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { fetchModelEntries, whitelistedIds } from '../../src/catalog.js'
import { REGIONS } from '../../src/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const text = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(text)
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}

async function raw(url, domain, token, ua) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Domain': domain,
      'X-Product': 'SaaS',
      'X-Product-Code': 'workbuddy',
      'User-Agent': ua
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status !== 200) return undefined
  return response.json()
}

for (const region of [REGIONS.cn, REGIONS.intl]) {
  const token = tokenOf(region.tokenRef)
  const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} }, credentials: { resolve: async () => ({ value: token }) } }
  console.log(`\n========== ${region.id} ==========`)

  const scoped = await raw(`${region.endpoint}/console/enterprises/personal/models`, region.apiDomain, token, region.userAgent)
  const config = await raw(`${region.endpoint}/v3/config`, region.apiDomain, token, region.userAgent)
  const scopedWhitelist = whitelistedIds(scoped?.data?.agents)
  const configWhitelist = whitelistedIds(config?.data?.agents)
  console.log('scoped 白名单:', scopedWhitelist.length, scopedWhitelist.length > 0 ? `→ ${scopedWhitelist.join(', ')}` : '(scoped 不可用)')
  console.log('config 白名单:', configWhitelist.length, `→ ${configWhitelist.join(', ')}`)
  const onlyConfig = configWhitelist.filter((id) => !scopedWhitelist.includes(id))
  const onlyScoped = scopedWhitelist.filter((id) => !configWhitelist.includes(id))
  if (scopedWhitelist.length > 0) {
    console.log('  仅出现在 config 白名单:', onlyConfig.join(', ') || '无')
    console.log('  仅出现在 scoped 白名单:', onlyScoped.join(', ') || '无')
  }

  const loaded = await fetchModelEntries(ctx, region)
  const ids = loaded.entries.map((entry) => entry.id)
  console.log(`目录来源: ${loaded.source} | 原始 reasons: ${loaded.reasons.join('；') || '无'}`)
  console.log(`准入后 ${ids.length} 个（official ${loaded.entries.filter((entry) => entry.official === true).length} 个）:`)
  console.log('  ' + ids.join(', '))
  const dropped = (config?.data?.models ?? []).map((model) => model.id).filter((id) => !ids.includes(id))
  console.log(`config 里被策略挡掉的 ${dropped.length} 个: ${dropped.slice(0, 30).join(', ')}${dropped.length > 30 ? ' …' : ''}`)
}
