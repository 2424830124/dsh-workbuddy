/**
 * On-disk cache of the model catalog.
 *
 * The live catalogs are the source of truth, but they are not always reachable:
 * China's scoped endpoint works while its config endpoint comes and goes, and
 * the international scoped endpoint has been answering 500 for a day at a time.
 * Without a cache the model list flips between populated and empty, which also
 * makes the agent forget models mid-session. So the last successful read is
 * kept per deployment and served when both live sources fail, clearly labelled
 * as cached data (the panel shows when it was taken).
 *
 * Write policy — **append**:
 *
 * - Every successful live read is merged into the file by model id: new ids are
 *   added, ids already known get their fields refreshed, and anything the read
 *   did not mention **stays**. A degraded upstream answer therefore cannot
 *   shrink the fallback list, and no shrink guard is needed.
 * - Each entry remembers `firstSeen` / `lastSeen`, so a future policy could
 *   expire entries that have not been seen for a long time; nothing expires
 *   them today.
 * - The write is atomic (staging file + rename), so a reader never sees a
 *   half-written list, and the replaced file is kept as `catalog-<region>.prev.json`
 *   for inspection or manual rollback.
 *
 * Location: `$DSH_HOME/cache/dsh-workbuddy/catalog-<region>.json`, falling back
 * to `~/.dsh/cache/...` when the environment does not set `DSH_HOME`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { isCatalogModelId, keepModel, withConsistentEfforts } from './catalog.js'

const CACHE_VERSION = 1
/** Modality order used across the catalog entries. */
const MODALITY_ORDER = ['text', 'image']
/**
 * Fields that are *not* cached.
 *
 * `credits` is a live rate (and promotions move it), so a value read an hour
 * ago is not a fallback — it is wrong. The cache stores no copy, and a cached
 * entry therefore reports no rate at all; the panel shows 未知 rather than a
 * stale number.
 */
const VOLATILE_FIELDS = new Set(['credits'])

function cacheDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-workbuddy')
}

function cachePath(regionId) {
  return join(cacheDir(), `catalog-${regionId}.json`)
}

function previousPath(regionId) {
  return join(cacheDir(), `catalog-${regionId}.prev.json`)
}

function readFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== CACHE_VERSION) return undefined
    if (!Array.isArray(parsed.entries)) return undefined
    if (typeof parsed.savedAt !== 'number' || !Number.isFinite(parsed.savedAt)) return undefined
    return {
      // Volatile fields are dropped on read too: a snapshot written before they
      // were excluded must not leak a stale rate either. The admission policy
      // is applied as well — the cache appends, so an id excluded later has to
      // be filtered when reading. Because `credits` is never cached, the policy
      // reduces to "whitelisted" for cached entries, which is exactly the part
      // of the list that does not depend on a live rate.
      entries: parsed.entries
        .filter((entry) => isCatalogModelId(entry?.id))
        .map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !VOLATILE_FIELDS.has(key))))
        .filter(keepModel),
      source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
      savedAt: parsed.savedAt,
      /** How many models the read behind this snapshot actually returned. */
      liveCount: typeof parsed.liveCount === 'number' ? parsed.liveCount : parsed.entries.length
    }
  } catch {
    return undefined
  }
}

/** @returns {{ entries: object[], source: string, savedAt: number, liveCount: number } | undefined} */
export function readCatalogCache(regionId) {
  const cached = readFile(cachePath(regionId))
  return cached === undefined || cached.entries.length === 0 ? undefined : cached
}

/**
 * Merge one live read into the cache and store it.
 *
 * Fields the fresh read does not carry never erase what is already known: a
 * catalog endpoint that answers with a thinner record (scoped omits
 * `supportedEfforts` for 24 of 34 China models, `/v3/config` omits `top_k` and
 * `repetition_penalty` entirely) must not degrade an entry another read already
 * described better. Capability and level fields are unioned for the same
 * reason; everything else is refreshed when the fresh record supplies a value.
 *
 * @returns {{ saved: boolean, total: number, added: number }}
 */
export function writeCatalogCache(regionId, source, entries) {
  try {
    const previous = readFile(cachePath(regionId))
    const now = Date.now()
    const byId = new Map()
    for (const entry of previous?.entries ?? []) {
      byId.set(entry.id, {
        ...entry,
        firstSeen: typeof entry.firstSeen === 'number' ? entry.firstSeen : previous.savedAt,
        lastSeen: typeof entry.lastSeen === 'number' ? entry.lastSeen : previous.savedAt
      })
    }
    const before = byId.size
    for (const entry of entries) {
      const known = byId.get(entry.id)
      byId.set(entry.id, {
        ...known,
        ...definedOnly(entry),
        ...(known === undefined ? {} : carryForward(known, entry)),
        firstSeen: known?.firstSeen ?? now,
        lastSeen: now
      })
      // Nothing volatile is persisted, not even from the read that just ran.
      for (const field of VOLATILE_FIELDS) delete byId.get(entry.id)[field]
    }

    const dir = cacheDir()
    mkdirSync(dir, { recursive: true })
    const staging = join(tmpdir(), `dsh-workbuddy-catalog-${regionId}-${process.pid}.json`)
    writeFileSync(staging, JSON.stringify({
      version: CACHE_VERSION,
      savedAt: now,
      source,
      liveCount: entries.length,
      entries: [...byId.values()]
    }))
    try {
      renameSync(cachePath(regionId), previousPath(regionId))
    } catch {
      // no previous snapshot — nothing to keep
    }
    renameSync(staging, cachePath(regionId))
    return { saved: true, total: byId.size, added: byId.size - before }
  } catch {
    return { saved: false, total: entries.length, added: 0 }
  }
}

/** Drop own properties whose value is `undefined`, so a spread cannot erase. */
function definedOnly(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))
}

/**
 * What the previous record knows and the fresh one does not. A missing key and
 * an explicitly empty list are treated the same: neither is evidence that the
 * capability went away.
 */
function carryForward(known, entry) {
  const carried = {}
  for (const [key, value] of Object.entries(known)) {
    if (key === 'firstSeen' || key === 'lastSeen' || key === 'id' || VOLATILE_FIELDS.has(key)) continue
    const fresh = entry[key]
    if (fresh === undefined || (Array.isArray(fresh) && fresh.length === 0) || (typeof fresh === 'object' && fresh !== null && !Array.isArray(fresh) && Object.keys(fresh).length === 0)) {
      carried[key] = value
    }
  }
  const modalities = new Set([...(known.input ?? []), ...(entry.input ?? [])])
  if (modalities.size > 0) carried.input = MODALITY_ORDER.filter((modality) => modalities.has(modality))
  const levels = { ...(known.efforts ?? {}), ...(entry.efforts ?? {}) }
  if (Object.keys(levels).length > 0) carried.efforts = levels
  // The union of two snapshots can hold a default that the union's level set
  // does not: normalise here too, since this result is handed straight to the
  // adapter (which the harness validates).
  return withConsistentEfforts({ ...entry, ...carried }, [known.defaultEffort])
}
