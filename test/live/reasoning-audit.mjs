/**
 * Dev probe: what does upstream say about reasoning right now?
 *
 * The plugin ignores `canDisableThinking` on purpose — upstream publishes the flag
 * without naming any parameter that would act on it, and it stops sending the flag
 * for models it used to describe (protocol §4.3.1). This keeps an eye on the field
 * shapes and on which ids upstream currently describes, so the decision can be
 * revisited with data if upstream ever publishes a real switch.
 *
 * Run: `node test/live/reasoning-audit.mjs [cn|intl]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/account/auth.js'
import { REGIONS } from '../../src/core/regions.js'

const region = REGIONS[process.argv[2] ?? 'cn']

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const readTokenFromHome = async (ref) => {
  const path = `${home}/.credentials.yaml`
  const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(path, 'utf8'))
  return match === null ? undefined : match[1].trim().replace(/^["']|["']$/g, '')
}
const ctx = {
  logger: { info: () => {}, warn: console.warn, error: console.error },
  credentials: { resolve: async (ref) => {
    const value = await readTokenFromHome(ref)
    return value === undefined ? undefined : { value }
  } }
}

const token = await readToken(ctx, region)
const url = region.id === 'cn'
  ? `https://${region.apiDomain}/console/enterprises/personal/models`
  : `https://${region.apiDomain}/v3/config`
// The same header set the plugin sends: without the product headers the gateway
// answers `12403 check ua, get coding copilot version error`.
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
if (payload.code !== undefined && payload.code !== 0) {
  console.log(`${region.id}: 上游返回 code ${payload.code} — ${payload.msg ?? ''}`)
}

/** Every model record in the payload, however deeply nested. */
const records = []
const walk = (node) => {
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node === null || typeof node !== 'object') return
  if (typeof node.id === 'string') records.push(node)
  for (const value of Object.values(node)) if (typeof value === 'object' && value !== null) walk(value)
}
walk(payload)

const live = new Map()
for (const record of records) {
  const previous = live.get(record.id)
  // Merge field-wise: the same id can appear in several blocks, and the richest
  // record is the one that carries the capability flags.
  live.set(record.id, previous === undefined ? { ...record } : { ...previous, ...record })
}

const cachePath = `${home}/cache/dsh-workbuddy/catalog-${region.id}.json`
let cached = []
try { cached = JSON.parse(readFileSync(cachePath, 'utf8')).entries ?? [] } catch { /* no cache yet */ }

const cacheById = new Map(cached.map((entry) => [entry.id, entry]))
const allIds = [...new Set([...live.keys(), ...cacheById.keys()])].sort()

// `/v3/config` names models in its own shape; when nothing was recognised, show
// the skeleton so the record key is visible instead of silently reporting zero.
if (live.size === 0) {
  const skeleton = (node, depth = 0) => {
    if (depth > 4 || node === null || typeof node !== 'object') return typeof node
    if (Array.isArray(node)) return `[${node.length} × ${skeleton(node[0], depth + 1)}]`
    return `{ ${Object.keys(node).slice(0, 14).join(', ')} }`
  }
  console.log('未识别到模型记录，响应骨架如下：')
  for (const [key, value] of Object.entries(payload)) console.log(`  ${key}: ${skeleton(value)}`)
  const keysSeen = new Set()
  const collect = (node, depth = 0) => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.slice(0, 5).forEach((child) => collect(child, depth + 1)); return }
    for (const key of Object.keys(node)) keysSeen.add(key)
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') collect(value, depth + 1)
  }
  collect(payload)
  console.log('\n出现的键名（抽样）:', [...keysSeen].sort().slice(0, 60).join(', '))
}

console.log(`=== ${region.id} — 上游 ${live.size} 个 id，缓存 ${cached.length} 条`)
console.log('id'.padEnd(26), '上游 canDisable', '上游 effort/summary', '上游相关字段')
for (const id of allIds) {
  const raw = live.get(id)
  if (raw?.reasoning === undefined && raw?.supportsReasoning === undefined) continue
  const flags = Object.keys(raw).filter((key) => /reason|think/i.test(key)).sort()
  console.log(
    id.padEnd(26),
    String(raw.reasoning?.canDisableThinking ?? '—').padEnd(15),
    `${raw.reasoning?.effort ?? '—'}/${raw.reasoning?.summary ?? '—'}`.padEnd(18),
    flags.join(',')
  )
}

// The plugin never caches the flag; a snapshot still holding it is stale data
// that the read filter drops, and this shows whether any is left behind.
const stale = cached.filter((entry) => entry.canDisableThinking !== undefined)
console.log(`\n缓存里仍带 canDisableThinking 的条目: ${stale.length} 个（读取时会被丢弃）`)

// Which field names upstream uses anywhere near reasoning, so a disable
// parameter would be visible if it existed.
const reasoningKeys = new Set()
for (const record of records) for (const key of Object.keys(record.reasoning ?? {})) reasoningKeys.add(key)
console.log('\n上游 reasoning 的全部字段:', [...reasoningKeys].sort().join(', ') || '(无)')
const paramish = new Set()
for (const record of records) for (const key of Object.keys(record)) if (/param|disable|enable|switch|flag|think/i.test(key)) paramish.add(key)
console.log('上游记录里像"开关参数"的字段:', [...paramish].sort().join(', ') || '(无)')
