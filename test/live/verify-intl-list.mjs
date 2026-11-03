/**
 * Dev probe: what the international catalog looks like once the account list
 * captured from the web session is applied.
 *
 * Run: `node test/live/verify-intl-list.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { readOfficialList } from '../../src/catalog/official-list.js'
import { REGIONS } from '../../src/core/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const token = (/^[ \t]*WORKBUDDY_INTL_TOKEN:[ \t]*(.+)$/m.exec(readFileSync(credentialsPath, 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '')

const list = readOfficialList('intl')
console.log('导入的账号名单:', list === undefined ? '(无)' : `${list.ids.length} 个，来源 ${list.from}，时间 ${new Date(list.importedAt).toLocaleString()}`)

const ctx = {
  logger: { info: (...args) => console.log('[info]', ...args), warn: (...args) => console.log('[warn]', ...args), error: () => {} },
  credentials: { resolve: async () => ({ value: token }), set: async () => {} },
  get: () => undefined
}

const adapter = new WorkBuddyAdapter(ctx, REGIONS.intl)
const models = await adapter.models()
const official = models.filter((model) => model.official === true)
const others = models.filter((model) => model.official !== true)
console.log(`\nsource=${adapter.catalogSource} 共 ${models.length} 个（官方 ${official.length} / 其他 ${others.length}）`)
console.log('官方名单:', official.map((model) => `${model.id}${model.credits === undefined ? '' : `(${model.credits.replace(/^x/, '')})`}`).join(', '))
console.log('其他可用:', others.map((model) => `${model.id}${model.credits === undefined ? '(无倍率)' : ''}`).join(', '))

const missing = (list?.ids ?? []).filter((id) => !['default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model'].includes(id) && !models.some((model) => model.id === id))
console.log('\n账号名单里有、列表里没有的:', missing.join(', ') || '无')
