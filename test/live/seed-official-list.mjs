/**
 * Store a deployment's account list from a browser capture.
 *
 * The plugin's `POST /workbuddy/import` route is the intended path, but the host
 * applies a trust fence to `/workbuddy/*`: only requests originating from the
 * GUI page pass it, so a script cannot post. This writes the same file the route
 * writes, through the same module, so the format cannot drift.
 *
 * Run: `node test/live/seed-official-list.mjs intl`
 *      `node test/live/seed-official-list.mjs intl id1 id2 …`
 *      `node test/live/seed-official-list.mjs intl --clear`
 */

import { readOfficialList, writeOfficialList } from '../../src/catalog/official-list.js'

const region = process.argv[2] ?? 'intl'
const args = process.argv.slice(3)

/** Captured 2026-10-21 from the signed-in console (`/console/enterprises/personal/models`). */
const CAPTURED = {
  intl: ['default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model', 'hy4-preview', 'hy3', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gemini-3.5-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.6']
}

const ids = args.includes('--clear') ? [] : (args.length > 0 ? args : (CAPTURED[region] ?? []))
if (ids.length === 0 && !args.includes('--clear')) {
  console.log(`no ids for ${region}: pass them as arguments`)
  process.exit(1)
}

const before = readOfficialList(region)
console.log('before:', before === undefined ? '(none)' : `${before.ids.length} ids from ${before.from}`)
const result = writeOfficialList(region, ids, { from: 'web-session-capture' })
const after = readOfficialList(region)
console.log('write:', JSON.stringify(result))
console.log('after:', after === undefined ? '(cleared)' : `${after.ids.length} ids from ${after.from} @ ${new Date(after.importedAt).toLocaleString()}`)
