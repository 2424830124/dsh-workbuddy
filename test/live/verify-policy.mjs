/**
 * Dev probe (throwaway): confirm the live catalog minus the availability
 * ledger's dead verdicts, and print both numbers.
 *
 * Run: `node test/live/verify-policy.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { availabilitySummary } from '../../src/catalog/availability.js'
import { REGIONS } from '../../src/core/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const token = (/^[ \t]*WORKBUDDY_CN_TOKEN:[ \t]*(.+)$/m.exec(readFileSync(credentialsPath, 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
console.log('token 长度:', token.length)

const ctx = {
  logger: { info: (...args) => console.log('[info]', ...args), warn: (...args) => console.log('[warn]', ...args), error: () => {} },
  credentials: { resolve: async () => ({ value: token }), set: async () => {} },
  get: () => undefined
}

const ledger = availabilitySummary('cn')
const dead = new Set(Object.entries(ledger.counts).length === 0 ? [] : ledger.models.filter((model) => model.state === 'dead').map((model) => model.id))
console.log('台账:', JSON.stringify(ledger.counts), '| dead:', [...dead].join(', ') || '无')

const adapter = new WorkBuddyAdapter(ctx, REGIONS.cn)
const list = await adapter.models()
console.log(`source=${adapter.catalogSource} 最终 ${list.length} 个（official ${list.filter((model) => model.official === true).length}）`)
console.log('  ' + list.map((model) => model.id).join(', '))
const missing = [...dead].filter((id) => !list.some((model) => model.id === id))
console.log('台账里判死、列表中已移除:', missing.length, '/', dead.size)
