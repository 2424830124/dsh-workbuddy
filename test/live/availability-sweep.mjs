/**
 * Dev probe: run the availability sweep for the China deployment and print the
 * verdicts, so the "catalog says yes but the gateway says 11102" models can be
 * told apart from the ones that actually answer.
 *
 * Run: `node test/live/availability-sweep.mjs [cn|intl] [all]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { runSweep, availabilitySummary } from '../../src/availability.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const region = REGIONS[process.argv[2] ?? 'cn']
const sweepAll = process.argv.includes('all')

const ctx = {
  logger: { info: (...args) => console.log('[info]', ...args), warn: (...args) => console.warn('[warn]', ...args), error: console.error },
  credentials: { resolve: async (ref) => {
    const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
    const match = new RegExp(`^[ \\t]*${ref}:[ \\t]*(.+)$`, 'm').exec(readFileSync(credentialsPath, 'utf8'))
    return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
  } }
}

const { fetchModelEntries } = await import('../../src/catalog.js')
const token = await readToken(ctx, region)
const loaded = await fetchModelEntries(ctx, region)
const targets = loaded.entries.filter((entry) => sweepAll || entry.official !== true)

console.log(`${region.id}: 目录 ${loaded.entries.length} 个（来源 ${loaded.source}），本次探测 ${targets.length} 个${sweepAll ? '（全部）' : '（白名单外）'}`)
const started = Date.now()
const results = await runSweep(ctx, region, targets.map((entry) => entry.id), {
  onResult: (result) => console.log(`  ${result.id.padEnd(24)} ${result.state.padEnd(10)} ${String(result.ms).padStart(5)}ms ${result.detail}`)
})
console.log(`用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

const byState = new Map()
for (const result of results) byState.set(result.state, [...(byState.get(result.state) ?? []), result.id])
for (const [state, ids] of byState) console.log(`${state}: ${ids.length} → ${ids.join(', ')}`)

const stale = targets.map((entry) => entry.id).filter((id) => !results.some((result) => result.id === id))
if (stale.length > 0) console.log('未探测:', stale.join(', '))
console.log('台账:', JSON.stringify(availabilitySummary(region.id).counts))
