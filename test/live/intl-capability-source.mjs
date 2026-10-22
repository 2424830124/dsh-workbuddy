/** Where did the overseas canDisableThinking values come from? */
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

// 1) What the overseas config route actually answers right now.
const token = await readToken(ctx, REGIONS.intl)
const response = await fetch(`https://${REGIONS.intl.apiDomain}/v3/config`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
})
const payload = await response.json()
console.log('intl /v3/config →', response.status, JSON.stringify(payload).slice(0, 300))

// 2) The imported console capture, which is the other source that can carry
//    reasoning metadata (and where a stale capability could hide).
for (const region of ['cn', 'intl']) {
  for (const name of [`official-${region}.json`, `catalog-${region}.json`]) {
    let parsed
    try { parsed = JSON.parse(readFileSync(`${home}/cache/dsh-workbuddy/${name}`, 'utf8')) } catch { continue }
    const records = Array.isArray(parsed) ? parsed : (parsed.models ?? parsed.entries ?? [])
    if (!Array.isArray(records) || records.length === 0) continue
    const flagged = records.filter((record) => (record.canDisableThinking ?? record.reasoning?.canDisableThinking) !== undefined)
    console.log(`\n${name}: ${records.length} 条，带 canDisableThinking 的 ${flagged.length} 条`)
    for (const record of flagged.slice(0, 6)) {
      console.log('  ', JSON.stringify({ id: record.id, canDisableThinking: record.canDisableThinking ?? record.reasoning?.canDisableThinking, from: record.from, importedAt: record.importedAt }))
    }
  }
}
