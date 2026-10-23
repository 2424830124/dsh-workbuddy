/**
 * Unit check for the imported account list: it decides who is `official`, it
 * cannot smuggle presets or aliases back in, and it survives a deployment
 * catalog that disagrees with it.
 *
 * Run: `node test/unit/official-list.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-official-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { applyOfficialList, readOfficialList, writeOfficialList } = await import('../../src/catalog/official-list.js')

assert.equal(readOfficialList('intl'), undefined, 'nothing imported yet')

// The captured list includes the presets the console offers; they are stored
// verbatim (it is a capture) and filtered when applied.
const captured = ['default-model', 'fast-model', 'hy4-preview', 'hy3', 'gpt-5.3-codex', 'gpt-5.6-sol']
const written = writeOfficialList('intl', captured, { from: 'web-session-capture' })
assert.deepEqual(written, { saved: true, count: 6, withMeta: 0 })
const stored = readOfficialList('intl')
assert.deepEqual(stored.ids, captured)
assert.equal(stored.from, 'web-session-capture')
assert.ok(stored.importedAt > 0)

// Applying it to a deployment catalog: members are marked, non-members are
// demoted, unknown members are appended, presets are dropped on both sides.
const entries = [
  { id: 'hy3', name: 'Hy3', input: ['text'], credits: 'x0.00' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', input: ['text'], credits: 'x3.47' },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', input: ['text'], credits: 'x6.67' },
  { id: 'default-model', name: 'Auto', input: ['text'] },
  { id: 'fast-model', name: 'Fast', input: ['text'], credits: 'x0.34' }
]
const applied = applyOfficialList(entries, stored)
assert.deepEqual(applied.entries.map((entry) => entry.id), ['hy3', 'gpt-5.6-sol', 'gpt-6-astra', 'hy4-preview', 'gpt-5.3-codex'], 'presets dropped, account-only members appended')
assert.equal(applied.added, 2, 'hy4-preview and gpt-5.3-codex are joined from the account list')
assert.equal(applied.official, 4, 'the captured list minus its presets')
assert.deepEqual(applied.entries.filter((entry) => entry.official === true).map((entry) => entry.id), ['hy3', 'gpt-5.6-sol', 'hy4-preview', 'gpt-5.3-codex'])
assert.equal(applied.entries.find((entry) => entry.id === 'gpt-5.3-codex').imported, true, 'an appended model is marked as imported')
assert.notEqual(applied.entries.find((entry) => entry.id === 'gpt-6-astra').official, true, 'a model outside the account list is not official')

// Without an imported list nothing is touched.
const untouched = applyOfficialList(entries, undefined)
assert.equal(untouched.added, 0)
assert.deepEqual(untouched.entries.map((entry) => entry.id), entries.map((entry) => entry.id))

// Clearing hands the deployment back to its own payloads.
assert.deepEqual(writeOfficialList('intl', []), { saved: true, count: 0, cleared: true })
assert.equal(readOfficialList('intl'), undefined)

// Deployments keep separate lists.
writeOfficialList('cn', ['hy3'], { from: 'test' })
assert.equal(readOfficialList('cn').ids.length, 1)
assert.equal(readOfficialList('intl'), undefined, 'clearing intl left cn alone')

// A capture may carry model records rather than bare ids. Those fill in fields
// the live sources lack — but **never the rate**, which is live data: a captured
// price would be a stale number shown as current.
const rich = writeOfficialList('cn', [
  { id: 'hy3', name: 'Hy3（来自控制台）', credits: 'x9.99', creditsIsStale: true },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', maxInputTokens: 272000, supportsImages: true },
  { id: 'nope' }
], { from: 'console-objects' })
assert.equal(rich.count, 3, 'ids are stored from the records')
assert.equal(rich.withMeta, 2, 'a record that only carries an id stores no metadata')
const richList = readOfficialList('cn')
assert.equal(richList.ids.includes('gpt-5.3-codex'), true)

const richApplied = applyOfficialList([
  { id: 'hy3', name: 'Hy3', input: ['text'], credits: 'x0.00' },
  { id: 'gpt-5.3-codex', input: ['text'] }
], richList)
const hy3 = richApplied.entries.find((entry) => entry.id === 'hy3')
const codex = richApplied.entries.find((entry) => entry.id === 'gpt-5.3-codex')
assert.equal(hy3.credits, 'x0.00', 'a live rate always wins over a captured one')
assert.equal(hy3.name, 'Hy3', 'a captured name never replaces the live one')
assert.equal(codex.name, 'GPT-5.3-Codex', 'a captured name fills a missing one')
assert.equal(codex.contextWindow, 272000, 'captured metadata fills a thin entry')
assert.equal(codex.credits, undefined, 'no rate is invented from a capture')
assert.equal(codex.imported, undefined, 'a joined model is not marked imported')
assert.equal(richApplied.enriched, 1, 'only the thin entry was enriched')

// An imported list belongs to the account that imported it.
writeOfficialList('acct', ['hy3', 'glm-5.2'], { from: 'import', account: 'account-a' })
assert.equal(readOfficialList('acct', 'account-a').ids.length, 2, 'the importing account sees its list')
assert.equal(readOfficialList('acct', 'account-b'), undefined, 'another account does not inherit it')
assert.equal(readOfficialList('acct').ids.length, 2, 'without an account the raw list still reads (legacy callers)')

console.log('official-list.mjs: OK — import (ids or records), field-level enrichment without rates, policy filtering, per-account lists, and clearing verified')
