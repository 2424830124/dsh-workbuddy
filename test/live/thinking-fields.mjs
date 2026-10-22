/**
 * Dev probe: what does upstream publish about reasoning, verbatim?
 *
 * `docs/workbuddy-protocol.md` records the fields we consume, but two questions
 * need the raw record: whether a deployment names a *parameter* for disabling
 * thinking, and whether the two deployments disagree about the same model.
 *
 * Run: `node test/live/thinking-fields.mjs [cn|intl] [modelId …]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const region = REGIONS[process.argv[2] ?? 'cn']
const wanted = process.argv.slice(3)

const ctx = {
  logger: { info: (...args) => console.log('[info]', ...args), warn: (...args) => console.warn('[warn]', ...args), error: console.error },
  credentials: {
    resolve: async (ref) => {
      const path = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(path, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}

const token = await readToken(ctx, region)
if (token === undefined) {
  console.log(`${region.id}: 没有可用令牌，先 /workbuddy login ${region.id}`)
  process.exit(0)
}

// Fetch both catalog sources raw, so the record shape is visible as sent.
const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
const requests = region.id === 'cn'
  ? [['scoped', `https://${region.apiDomain}/console/enterprises/personal/models`]]
  : [['config', `https://${region.apiDomain}/v3/config`]]

for (const [label, url] of requests) {
  let payload
  try {
    const response = await fetch(url, { headers })
    payload = await response.json()
    console.log(`\n=== ${region.id} / ${label} → HTTP ${response.status}`)
  } catch (error) {
    console.log(`\n=== ${region.id} / ${label} → 请求失败: ${error.message}`)
    continue
  }
  const records = []
  const walk = (node, path = '$') => {
    if (Array.isArray(node)) { node.forEach((child, index) => walk(child, `${path}[${index}]`)); return }
    if (node === null || typeof node !== 'object') return
    const id = typeof node.id === 'string' ? node.id : (typeof node.modelId === 'string' ? node.modelId : undefined)
    if (id !== undefined && (node.reasoning !== undefined || node.name !== undefined)) records.push({ path, record: node })
    for (const [key, value] of Object.entries(node)) if (typeof value === 'object' && value !== null) walk(value, `${path}.${key}`)
  }
  walk(payload)
  console.log(`  记录数: ${records.length}`)
  const withReasoning = records.filter(({ record }) => record.reasoning !== undefined)
  console.log(`  带 reasoning 的: ${withReasoning.length}`)
  const keys = new Set()
  for (const { record } of withReasoning) for (const key of Object.keys(record.reasoning ?? {})) keys.add(key)
  console.log('  reasoning 出现过的字段:', [...keys].sort().join(', ') || '(无)')
  // An id can appear in several places (an agent's model list, the flat model
  // list, a recommendation block), and the records differ; print every one so a
  // field we rely on can be traced to the record that actually carries it.
  const shown = wanted.length === 0 ? withReasoning.slice(0, 3) : records.filter(({ record }) => wanted.includes(record.id ?? record.modelId))
  for (const { path, record } of shown) {
    console.log(`  · ${record.id ?? record.modelId}  @${path}`)
    console.log(`      ${JSON.stringify(record)}`)
  }
}
