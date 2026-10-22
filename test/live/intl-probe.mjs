/**
 * Dev probe: which catalog endpoint answers for the international deployment,
 * exercised through the plugin's own resolution path. Reads the stored token
 * from the shared credential document and prints status codes and shapes only.
 *
 * Run: `node test/intl-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { fetchModelEntries } from '../../src/catalog.js'
import { REGIONS } from '../../src/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const text = readFileSync(credentialsPath, 'utf8')
const match = /^[ \t]*WORKBUDDY_INTL_TOKEN:[ \t]*(.+)$/m.exec(text)
if (match === null) {
  console.log('no WORKBUDDY_INTL_TOKEN found')
  process.exit(1)
}
const token = match[1].trim().replace(/^['"]|['"]$/g, '')
console.log('token length:', token.length)

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'X-Domain': 'www.workbuddy.ai',
  'X-Product': 'SaaS',
  'X-Product-Code': 'workbuddy',
  'User-Agent': 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
}

for (const path of ['/console/enterprises/personal/models', '/v3/config']) {
  try {
    const response = await fetch(`https://www.workbuddy.ai${path}`, { headers, signal: AbortSignal.timeout(30_000) })
    const body = await response.text()
    console.log(JSON.stringify({ path, status: response.status, body: body.slice(0, 200) }))
  } catch (error) {
    console.log(JSON.stringify({ path, error: String(error) }))
  }
}

// The plugin's own resolution: scoped first, `/v3/config` as the fallback.
const ctx = {
  logger: { info: () => {}, warn: (...args) => console.warn('[warn]', ...args) },
  credentials: { resolve: async () => ({ value: token }) }
}
const resolved = await fetchModelEntries(ctx, REGIONS.intl)
console.log('fetchModelEntries ->', JSON.stringify({
  source: resolved.source,
  count: resolved.entries.length,
  first: resolved.entries.slice(0, 6).map((entry) => entry.id),
  reasons: resolved.reasons
}))
