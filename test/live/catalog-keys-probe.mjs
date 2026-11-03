/**
 * Dev probe: dump the full scoped catalog JSON and list every key it contains
 * (recursively), looking for the fields the web picker renders — busy level,
 * credits rate, thinking levels, descriptions.
 *
 * Run: `node test/live/catalog-keys-probe.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const token = (/^[ \t]*WORKBUDDY_CN_TOKEN:[ \t]*(.+)$/m.exec(readFileSync(credentialsPath, 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '')

const response = await fetch('https://www.workbuddy.cn/console/enterprises/personal/models', {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-Domain': 'www.workbuddy.cn',
    'X-Product': 'SaaS',
    'X-Product-Code': 'workbuddy',
    'User-Agent': 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'
  },
  signal: AbortSignal.timeout(30_000)
})
const json = await response.json()
const dumpPath = join(tmpdir(), 'workbuddy-cn-catalog.json')
writeFileSync(dumpPath, JSON.stringify(json, null, 2))
console.log('status', response.status, '→', dumpPath)

const keys = new Map()
const walk = (node, path, depth) => {
  if (depth > 6 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 3)) walk(item, `${path}[]`, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    const at = path === '' ? key : `${path}.${key}`
    if (!keys.has(at)) keys.set(at, typeof value === 'object' && value !== null ? (Array.isArray(value) ? 'array' : 'object') : JSON.stringify(value)?.slice(0, 40))
    walk(value, at, depth + 1)
  }
}
walk(json, '', 0)

const interesting = /busy|load|congest|status|speed|credit|effort|reason|desc|tag|badge|queue|avail|health/i
for (const [key, sample] of [...keys.entries()].sort()) {
  if (interesting.test(key)) console.log(`${key}  =  ${sample}`)
}
console.log('--- total keys:', keys.size)
