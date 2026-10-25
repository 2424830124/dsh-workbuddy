/**
 * Unit check for the on-disk catalog cache: appending, and above all that a
 * thinner later read never erases metadata an earlier read already supplied.
 * Also covers the admission policy being re-applied on read (the cache
 * appends, so an id excluded later must not come back from disk).
 *
 * Run: `node test/unit/catalog-cache.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-cache-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { readCatalogCache, writeCatalogCache } = await import('../../src/catalog/catalog-cache.js')

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
assert.ok(existsSync(join(process.env.DSH_HOME, 'dsh-workbuddy', 'catalog-cn.prev.json')), 'the replaced snapshot is kept as .prev')

// A different deployment has its own file.
assert.equal(readCatalogCache('intl'), undefined)
writeCatalogCache('intl', 'config', [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', official: true, preset: false }])
assert.equal(readCatalogCache('intl').entries.length, 1)
assert.equal(readCatalogCache('cn').entries.length, 2, 'deployments do not share a cache')

// The admission policy applied on read is the *structural* half: aliases and presets
// go, everything the deployment listed stays. It must not require a live rate, because
// rates are never cached — doing that emptied the cache for `/v3/config` reads, which
// is the only source the international deployment has when the scoped endpoint is down.
writeCatalogCache('cn', 'scoped', [
  { id: 'auto', name: 'Auto', preset: true },
  { id: 'fast-model', name: 'Fast', preset: true, official: false },
  { id: 'glm-5.0', name: 'GLM-5.0', preset: false, official: false },
  { id: 'hy4-preview', name: 'Hy4 preview', preset: false, official: true }
])
const filtered = readCatalogCache('cn')
assert.deepEqual(filtered.entries.map((entry) => entry.id).sort(), ['glm-5.0', 'glm-5.3', 'hy3', 'hy4-preview'])
assert.ok(!filtered.entries.some((entry) => entry.id === 'auto'), 'the alias is filtered on read')
assert.ok(!filtered.entries.some((entry) => entry.id === 'fast-model'), 'a preset is filtered on read')
assert.ok(filtered.entries.some((entry) => entry.id === 'glm-5.0'), 'a listed model survives without a cached rate')
assert.ok(filtered.entries.some((entry) => entry.id === 'hy4-preview'), 'a whitelisted model survives without a rate')

// A `/v3/config`-only entry (no `official`, no rate — the international fallback case)
// must survive the round trip, otherwise the cache is useless when both sources fail.
writeCatalogCache('intl-fallback', 'config', [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', input: ['text'], maxTokens: 200000 }])
const fallback = readCatalogCache('intl-fallback')
assert.equal(fallback.entries.length, 1, 'a config-only entry survives the cache round trip')
assert.equal(fallback.entries[0].credits, undefined, 'and still carries no stale rate')

// ── seven-day expiry, on the entry's own lastSeen ─────────────────────────────
//
// The live read is allowed to be thinner than reality: the international
// `/v3/config` listed 28 models and omitted `step-5-preview` (2026-10-26) while
// that model still answered a chat request. So an entry the read stopped
// mentioning stays — but not forever, and not on the snapshot's clock.

const EIGHT_DAYS_MS = 8 * 24 * 3600_000

// A model the deployment stops listing: `step-5-preview` is written once, then
// never again. Every later write must keep it for a week of its own silence.
writeCatalogCache('ttl', 'config', [
  { id: 'step-5-preview', name: 'Step-5-Preview', official: false, preset: false },
  { id: 'hy3', name: 'Hy3', official: true, preset: false }
])
// Backdate `step-5-preview`'s own lastSeen, leaving `hy3` as it is: only the
// silent one may expire.
const ttlPath = join(process.env.DSH_HOME, 'dsh-workbuddy', 'catalog-ttl.json')
const snapshot = JSON.parse(readFileSync(ttlPath, 'utf8'))
snapshot.entries = snapshot.entries.map((entry) => entry.id === 'step-5-preview'
  ? { ...entry, lastSeen: Date.now() - EIGHT_DAYS_MS }
  : entry)
writeFileSync(ttlPath, JSON.stringify(snapshot))

// The live read still lists `hy3` only. `step-5-preview` has been silent for
// eight days, so this write drops it.
writeCatalogCache('ttl', 'config', [{ id: 'hy3', name: 'Hy3', official: true, preset: false }])
const expired = readCatalogCache('ttl')
assert.ok(expired.entries.some((entry) => entry.id === 'hy3'), 'a model the read still lists stays')
assert.ok(!expired.entries.some((entry) => entry.id === 'step-5-preview'), 'an entry silent for eight days is dropped')

// Six days of silence is inside the TTL: the entry survives, which is what keeps
// a temporarily thin upstream answer from shrinking the list.
writeCatalogCache('ttl2', 'config', [
  { id: 'step-5-preview', name: 'Step-5-Preview', official: false, preset: false },
  { id: 'hy3', name: 'Hy3', official: true, preset: false }
])
const ttl2Path = join(process.env.DSH_HOME, 'dsh-workbuddy', 'catalog-ttl2.json')
const snapshot2 = JSON.parse(readFileSync(ttl2Path, 'utf8'))
snapshot2.entries = snapshot2.entries.map((entry) => entry.id === 'step-5-preview'
  ? { ...entry, lastSeen: Date.now() - 6 * 24 * 3600_000 }
  : entry)
writeFileSync(ttl2Path, JSON.stringify(snapshot2))
writeCatalogCache('ttl2', 'config', [{ id: 'hy3', name: 'Hy3', official: true, preset: false }])
assert.ok(readCatalogCache('ttl2').entries.some((entry) => entry.id === 'step-5-preview'), 'six days of silence is inside the TTL')

// The expiry reads the entry's own `lastSeen`, never the snapshot's `savedAt`:
// a read that mentions *other* models must not keep a silent one alive.
writeCatalogCache('ttl3', 'config', [
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', official: false, preset: false },
  { id: 'hy3', name: 'Hy3', official: true, preset: false }
])
const ttl3Path = join(process.env.DSH_HOME, 'dsh-workbuddy', 'catalog-ttl3.json')
const snapshot3 = JSON.parse(readFileSync(ttl3Path, 'utf8'))
snapshot3.entries = snapshot3.entries.map((entry) => entry.id === 'kimi-k2.6'
  ? { ...entry, lastSeen: Date.now() - EIGHT_DAYS_MS }
  : entry)
writeFileSync(ttl3Path, JSON.stringify(snapshot3))
writeCatalogCache('ttl3', 'config', [{ id: 'hy3', name: 'Hy3', official: true, preset: false }])
assert.ok(!readCatalogCache('ttl3').entries.some((entry) => entry.id === 'kimi-k2.6'), 'a read of other models does not refresh a silent entry')

// A snapshot written before the TTL existed still expires on read, because the
// cache may sit unread for a long time (it is consulted only when both live
// sources fail) — and on read `lastSeen` is gone, so `savedAt` stands in.
writeCatalogCache('ttl4', 'config', [{ id: 'step-5-preview', name: 'Step-5-Preview', official: false, preset: false }])
const ttl4Path = join(process.env.DSH_HOME, 'dsh-workbuddy', 'catalog-ttl4.json')
const snapshot4 = JSON.parse(readFileSync(ttl4Path, 'utf8'))
snapshot4.savedAt = Date.now() - EIGHT_DAYS_MS
snapshot4.entries = snapshot4.entries.map((entry) => {
  const bare = { ...entry }
  delete bare.lastSeen
  return bare
})
writeFileSync(ttl4Path, JSON.stringify(snapshot4))
assert.equal(readCatalogCache('ttl4'), undefined, 'a legacy snapshot whose only entry is long gone reads as no cache at all')

console.log('catalog-cache.mjs: OK — append, metadata preservation, per-deployment files, structural read-time filtering, the config-only fallback, and the seven-day lastSeen expiry verified')
