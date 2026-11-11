/**
 * Dev probe: which catalog endpoint answers for the international deployment,
 * exercised through the plugin's own resolution path. Reads the stored token
 * from the shared credential document and prints status codes and shapes only.
 *
 * Run: `node test/intl-probe.mjs`
 */

import { fetchModelEntries } from '../../src/catalog/catalog.js'
import { REGIONS } from '../../src/core/regions.js'
import { tokenOf } from './credentials.mjs'

const token = tokenOf('WORKBUDDY_INTL_TOKEN')
if (token.length === 0) {
  console.log('no WORKBUDDY_INTL_TOKEN found')
  process.exit(1)
}
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
