/**
 * Unit check for the on-disk catalog cache: appending, and above all that a
 * thinner later read never erases metadata an earlier read already supplied.
 * Also covers the admission policy being re-applied on read (the cache
 * appends, so an id excluded later must not come back from disk).
 *
 * Run: `node test/unit/catalog-cache.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-cache-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { readCatalogCache, writeCatalogCache } = await import('../../src/catalog-cache.js')

assert.equal(readCatalogCache('cn'), undefined, 'no cache before the first write')

// A rich first read. `official` marks a whitelisted model: the admission policy
// keeps those without a rate, which is what makes them survive a cache round
// trip (the rate itself is never cached).
const rich = writeCatalogCache('cn', 'scoped', [{
  id: 'hy3',
  name: 'Hy3',
  descriptionZh: '混元思考模型，具有增强的推理能力',
  descriptionEn: 'Enhanced reasoning',
  credits: 'x0.00 credits',
  contextWindow: 192000,
  maxTokens: 64000,
  input: ['text', 'image'],
  efforts: { low: 'low', high: 'high' },
  defaultEffort: 'high',
  canDisableThinking: false,
  promotion: { kind: '夜间折扣', endsAt: '2026-10-23' },
  thinking: true,
  official: true,
  preset: false
}])
assert.equal(rich.saved, true)
assert.equal(rich.total, 1)

// A thinner read of the same model plus one new model: the old fields survive.
const thin = writeCatalogCache('cn', 'config', [
  { id: 'hy3', name: 'Hy3', input: ['text'], official: true, preset: false },
  { id: 'glm-5.3', name: 'GLM-5.3', efforts: { low: 'low', high: 'high', max: 'max' }, official: true, preset: false }
])
assert.equal(thin.saved, true)
assert.equal(thin.total, 2, 'append keeps the previously known model')
assert.equal(thin.added, 1)

const cached = readCatalogCache('cn')
assert.equal(cached.entries.length, 2)
assert.equal(cached.liveCount, 2, 'liveCount records what the last read actually returned')

const hy3 = cached.entries.find((entry) => entry.id === 'hy3')
assert.equal(hy3.descriptionZh, '混元思考模型，具有增强的推理能力', 'description survives a read that omits it')
assert.equal(hy3.descriptionEn, 'Enhanced reasoning')
assert.equal(hy3.credits, undefined, 'the credits rate is volatile and is never cached')
// Retired fields must not survive in a snapshot written before they were retired:
// `canDisableThinking` is no longer produced, and the read filter strips the copy
// an older snapshot still holds.
assert.equal(hy3.canDisableThinking, undefined, 'a retired field is stripped from old snapshots')
assert.equal(hy3.promotion, undefined, 'a promotion moves with each campaign and is never cached')
assert.equal(hy3.contextWindow, 192000, 'context window survives')
assert.equal(hy3.maxTokens, 64000)
assert.deepEqual(hy3.input, ['text', 'image'], 'a modality once advertised is kept')
assert.deepEqual(hy3.efforts, { low: 'low', high: 'high' }, 'level sets survive; a missing list is not a downgrade')
assert.equal(hy3.defaultEffort, 'high')
assert.equal(hy3.name, 'Hy3')
assert.equal(typeof hy3.firstSeen, 'number')
assert.equal(typeof hy3.lastSeen, 'number')

// A richer later read updates fields it does carry.
writeCatalogCache('cn', 'scoped', [{
  id: 'hy3',
  name: 'Hy3 (updated)',
  credits: 'x0.10 credits',
  efforts: { low: 'low', high: 'high', max: 'max' },
  defaultEffort: 'max',
  input: ['text', 'image'],
  canDisableThinking: true,
  official: true
}])
const updated = readCatalogCache('cn').entries.find((entry) => entry.id === 'hy3')
assert.equal(updated.name, 'Hy3 (updated)', 'a supplied value wins')
assert.equal(updated.credits, undefined, 'a rate read now is still not persisted')
assert.equal(updated.canDisableThinking, undefined, 'a retired field is dropped even when a read supplies it')
assert.deepEqual(updated.efforts, { low: 'low', high: 'high', max: 'max' }, 'level sets union')
assert.equal(updated.defaultEffort, 'max')
assert.equal(updated.descriptionZh, '混元思考模型，具有增强的推理能力', 'still carried')
assert.ok(updated.lastSeen >= updated.firstSeen)

// The replaced snapshot is kept beside it for inspection.
assert.ok(existsSync(join(process.env.DSH_HOME, 'cache', 'dsh-workbuddy', 'catalog-cn.prev.json')), 'the replaced snapshot is kept as .prev')

// A different deployment has its own file.
assert.equal(readCatalogCache('intl'), undefined)
writeCatalogCache('intl', 'config', [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', official: true, preset: false }])
assert.equal(readCatalogCache('intl').entries.length, 1)
assert.equal(readCatalogCache('cn').entries.length, 2, 'deployments do not share a cache')

// The admission policy is applied on read: aliases, presets, and non-whitelisted
// models with no rate are dropped — a cached entry has no rate by construction,
// so in practice the cached list is the whitelist.
writeCatalogCache('cn', 'scoped', [
  { id: 'auto', name: 'Auto', preset: true },
  { id: 'fast-model', name: 'Fast', preset: true, official: false },
  { id: 'glm-5.0', name: 'GLM-5.0', preset: false, official: false },
  { id: 'hy4-preview', name: 'Hy4 preview', preset: false, official: true }
])
const filtered = readCatalogCache('cn')
assert.deepEqual(filtered.entries.map((entry) => entry.id).sort(), ['glm-5.3', 'hy3', 'hy4-preview'])
assert.ok(!filtered.entries.some((entry) => entry.id === 'auto'), 'the alias is filtered on read')
assert.ok(!filtered.entries.some((entry) => entry.id === 'glm-5.0'), 'a non-whitelisted model without a cached rate is filtered')
assert.ok(filtered.entries.some((entry) => entry.id === 'hy4-preview'), 'a whitelisted model survives without a rate')

console.log('catalog-cache.mjs: OK — append, metadata preservation, per-deployment files, and read-time policy filtering verified')
