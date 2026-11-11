/**
 * The account's own model list, imported from a web-console session.
 *
 * Neither deployment publishes this list to a plugin token on every route we
 * can reach: China's account-scoped endpoint does answer a bearer token, but
 * the international one answers `500` to tokens and `200` to the console
 * cookie (verified 2026-10-21 with a signed-in session; an unsigned one gets
 * `400 Client not found.`). `/v3/config` is a deployment list and provably is
 * not the account's — it carries ids the picker never shows (`gpt-6-astra`,
 * `grok-4.7`) and lacks ones it does (`gpt-5.3-codex`).
 *
 * So the account list is imported: a capture in a signed-in browser posts what
 * the console returned to `POST /workbuddy/import`, and it is stored here.
 * While a list exists for a deployment it is authoritative — those ids are
 * marked `official`, ids outside it are not, and ids the other sources do not
 * know yet are still offered (they are what the account can actually pick).
 *
 * The capture carries **metadata, not just ids** (`name`, `descriptionZh`,
 * `maxInputTokens`, `reasoning`…). That matters because the sources hold
 * different fields for the same model: `/v3/config` has a rate but not every id,
 * the account list has every id, and the local cache has history. An import
 * therefore enriches the catalog field by field instead of only flagging ids.
 * Rates are excluded from that enrichment on purpose (see `ENRICHABLE`).
 *
 * File: `$DSH_HOME/dsh-workbuddy/official-<region>[-<account>].json`
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { entryFromMeta, isAdvertisableId } from './catalog.js'
import { ensurePluginDir } from '../core/paths.js'
import { PRIMARY_ACCOUNT } from '../account/pool.js'

const LIST_VERSION = 1

function listDir() {
  return ensurePluginDir()
}

/**
 * The file for one deployment's imported list.
 *
 * One file per account, keyed the same way the availability ledger is: an imported list
 * is a statement about one account's entitlements, and with several accounts signed in
 * the second capture used to overwrite the first one outright.
 */
function listPath(regionId, account) {
  const id = typeof account === 'string' ? account : ''
  const suffix = id.length === 0 || id === PRIMARY_ACCOUNT ? '' : `-${id.replace(/[^A-Za-z0-9_-]/g, '')}`
  return join(listDir(), `official-${regionId}${suffix}.json`)
}

/**
 * One captured item: either a bare id (older captures) or a model record from
 * the console payload, which is run through the same parser the live catalogs
 * use so the fields land in their canonical shape.
 */
function normalizeItem(item) {
  if (typeof item === 'string') return { id: item }
  if (typeof item !== 'object' || item === null) return undefined
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (id.length === 0) return undefined
  return { ...entryFromMeta(id, item), id }
}

/** @returns {{ ids: string[], entries: object[], importedAt: number, from: string } | undefined} */
export function readOfficialList(regionId, account) {
  // Without an account the newest list of the deployment answers: that is what a caller
  // that only wants "is anything imported here" means, and it keeps the pre-pool call
  // shape working against a file that is now per account.
  const target = account === undefined ? newestListPath(regionId) : listPath(regionId, account)
  if (target === undefined) return undefined
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    if (parsed?.version !== LIST_VERSION || !Array.isArray(parsed.ids)) return undefined
    const ids = parsed.ids.filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length === 0) return undefined
    const entries = Array.isArray(parsed.entries) ? parsed.entries : []
    return {
      ids,
      entries,
      importedAt: typeof parsed.importedAt === 'number' ? parsed.importedAt : 0,
      from: typeof parsed.from === 'string' ? parsed.from : 'import'
    }
  } catch {
    return undefined
  }
}

/** The most recently written list of a deployment, whichever account imported it. */
function newestListPath(regionId) {
  try {
    const prefix = `official-${regionId}`
    let best
    let bestAt = -1
    for (const name of readdirSync(listDir())) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      // `official-cn-acc-1.json` belongs to cn; `official-cnintl.json` does not.
      const rest = name.slice(prefix.length, -'.json'.length)
      if (rest.length > 0 && !rest.startsWith('-')) continue
      const full = join(listDir(), name)
      const at = statSync(full).mtimeMs
      if (at <= bestAt) continue
      best = full
      bestAt = at
    }
    return best
  } catch {
    return undefined
  }
}

/**
 * Store the account list. An empty list clears it, which hands the deployment
 * back to whatever its own payloads say.
 *
 * @param {(string | object)[]} models ids or captured model records
 * @returns {{ saved: boolean, count: number, cleared?: boolean, withMeta?: number }}
 */
export function writeOfficialList(regionId, models, options = {}) {
  try {
    const byId = new Map()
    for (const item of models ?? []) {
      const entry = normalizeItem(item)
      if (entry === undefined) continue
      // "Rich" means the capture said more than the id: only those records are
      // worth storing, so a bare-id capture stays exactly as small as before.
      const rich = typeof item === 'object' && item !== null && Object.keys(item).some((key) => key !== 'id')
      const previous = byId.get(entry.id)
      byId.set(entry.id, {
        entry: { ...(previous?.entry ?? {}), ...entry },
        rich: rich || previous?.rich === true
      })
    }
    if (byId.size === 0) {
      try {
        renameSync(listPath(regionId, options.account), `${listPath(regionId, options.account)}.cleared-${Date.now()}`)
      } catch {
        // nothing to clear
      }
      return { saved: true, count: 0, cleared: true }
    }
    const ids = [...byId.keys()]
    const entries = ids.filter((id) => byId.get(id).rich).map((id) => byId.get(id).entry)
    mkdirSync(listDir(), { recursive: true })
    // Staged in the target directory so the rename cannot fail with EXDEV.
    const staging = join(listDir(), `.official-${regionId}-${process.pid}-${Date.now()}.json`)
    writeFileSync(staging, JSON.stringify({
      version: LIST_VERSION,
      ...(typeof options.account === 'string' && options.account.length > 0 ? { account: options.account } : {}),
      importedAt: Date.now(),
      from: typeof options.from === 'string' && options.from.length > 0 ? options.from : 'import',
      ids,
      entries
    }))
    renameSync(staging, listPath(regionId, options.account))
    return { saved: true, count: ids.length, withMeta: entries.length }
  } catch {
    return { saved: false, count: 0 }
  }
}

/**
 * Every account's imported list of one deployment, as one list.
 *
 * The picker offers models per deployment, and a request is routed to whichever account
 * can answer, so the list has to be the union: a model that only the second account may
 * call is still callable. Entries are merged field by field (the same rule the catalog
 * cache uses), ids are de-duplicated, and nothing is invented — a list that only exists
 * for one account simply contributes its own ids.
 *
 * @returns {{ ids: string[], entries: object[], importedAt: number, from: string } | undefined}
 */
export function mergedOfficialList(regionId, accounts) {
  const names = Array.isArray(accounts) && accounts.length > 0 ? accounts : [undefined]
  const lists = names.map((account) => readOfficialList(regionId, account)).filter((list) => list !== undefined)
  if (lists.length === 0) return undefined
  if (lists.length === 1) return lists[0]
  const ids = []
  const byId = new Map()
  for (const list of lists) {
    for (const id of list.ids) if (!ids.includes(id)) ids.push(id)
    for (const entry of list.entries) {
      const previous = byId.get(entry.id)
      byId.set(entry.id, previous === undefined ? entry : { ...previous, ...entry })
    }
  }
  return {
    ids,
    entries: [...byId.values()],
    importedAt: lists.reduce((latest, list) => Math.max(latest, list.importedAt ?? 0), 0),
    from: lists.map((list) => list.from).filter(Boolean).join(', ')
  }
}

/**
 * Fields an import may fill in when the live sources do not have them.
 *
 * `credits` is deliberately **not** here: a rate is live data (promotions move
 * it), so a captured or cached number would be a stale price shown as if it were
 * current. A model whose rate cannot be read right now reads 「未知」 — which is
 * why the console capture keeps the other fields only.
 */
const ENRICHABLE = ['name', 'descriptionZh', 'descriptionEn', 'contextWindow', 'maxTokens', 'defaultEffort', 'requiredUserType']

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function enrich(entry, captured) {
  if (captured === undefined) return entry
  const patch = {}
  for (const field of ENRICHABLE) {
    if (entry[field] === undefined && captured[field] !== undefined) patch[field] = captured[field]
  }
  const levels = [...new Set([
    ...(entry.efforts === undefined ? [] : Object.keys(entry.efforts)),
    ...(captured.efforts === undefined ? [] : Object.keys(captured.efforts))
  ])]
  if (levels.length > 0) patch.efforts = Object.fromEntries(levels.map((level) => [level, level]))
  // Input modalities only ever grow: a capture cannot take `image` away from a
  // model the live payload says accepts images.
  if (captured.input !== undefined && captured.input.length > (entry.input === undefined ? 0 : entry.input.length)) {
    patch.input = captured.input
  }
  const changed = Object.entries(patch).filter(([field, value]) => !same(entry[field], value))
  return changed.length === 0 ? entry : { ...entry, ...Object.fromEntries(changed) }
}

/**
 * Apply the list to a catalog: mark members `official`, demote the rest, enrich
 * members whose live entry is missing fields, and append members no other
 * source knows about so they are still selectable.
 *
 * Everything passing through here is filtered by {@link isAdvertisableId}: an
 * imported list is a capture of what the console offered, presets included, and
 * it must not smuggle router presets or bare aliases back into the picker after
 * the admission policy dropped them.
 *
 * @param {object[]} entries
 * @returns {{ entries: object[], added: number, enriched: number, official: number }}
 */
export function applyOfficialList(entries, list) {
  if (list === undefined) {
    return { entries, added: 0, enriched: 0, official: entries.filter((entry) => entry.official === true).length }
  }
  const captured = new Map((list.entries ?? []).map((entry) => [entry.id, entry]))
  const advertised = entries.filter((entry) => isAdvertisableId(entry.id))
  const wanted = new Set(list.ids.filter((id) => isAdvertisableId(id)))
  const seen = new Set(advertised.map((entry) => entry.id))
  let enriched = 0
  const marked = advertised.map((entry) => {
    const withMeta = enrich(entry, captured.get(entry.id))
    if (withMeta !== entry) enriched += 1
    return (wanted.has(entry.id) === (withMeta.official === true) ? withMeta : { ...withMeta, official: wanted.has(entry.id) })
  })
  const appended = [...wanted]
    .filter((id) => !seen.has(id))
    .map((id) => {
      const meta = captured.get(id)
      return meta === undefined
        ? { id, name: id, input: ['text'], official: true, imported: true }
        : { ...meta, official: true, imported: true }
    })
  return { entries: [...marked, ...appended], added: appended.length, enriched, official: wanted.size }
}
