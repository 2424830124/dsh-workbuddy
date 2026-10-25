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
/**
 * Write policy — **append, with one expiry**:
 *
 * - Every successful live read is merged into the file by model id: new ids are
 *   added, ids already known get their fields refreshed, and anything the read
 *   did not mention **stays** — until it has been missing for
 *   {@link ENTRY_TTL_MS}. A degraded upstream answer therefore cannot shrink
 *   the fallback list, but a model the deployment genuinely stopped listing
 *   eventually leaves it instead of lingering forever.
 * - Each entry remembers `firstSeen` / `lastSeen`; `lastSeen` is the model's own
 *   activity clock and is what the expiry reads. Nothing expires it before
 *   {@link ENTRY_TTL_MS}.
 * - The write is atomic (staging file + rename), so a reader never sees a
 *   half-written list, and the replaced file is kept as `catalog-<region>.prev.json`
 *   for inspection or manual rollback.
 *
 * Why expiry at all: the cache exists to bridge an upstream outage, and a
 * delisted model was expected to disappear with it. `step-5-preview` disproved
 * that — the international deployment stopped listing it in `/v3/config`
 * (2026-10-26, 28 models, no `step` id) while it still answers a chat request
 * (`200`, 11 prompt tokens). With no expiry the cached entry survived, but it
 * was unreachable: the cache is only read when *both* live sources fail, so the
 * live list — which is what the picker actually offers — never grew it back.
 * The TTL turns "stays forever but unusable" into "stays until the deployment
 * really stops offering it", measured on the model's own last-seen day rather
 * than on the snapshot's `savedAt`, which every successful read of *any* model
 * would otherwise refresh.
 *
 * Location: `$DSH_HOME/cache/dsh-workbuddy/catalog-<region>.json`, falling back
 * to `~/.dsh/cache/...` when the environment does not set `DSH_HOME`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isCatalogModelId, keepModel, withConsistentEfforts } from './catalog.js'
import { ensurePluginDir } from '../core/paths.js'

const CACHE_VERSION = 1
/**
 * How long an entry the deployment no longer lists survives in the cache.
 *
 * Seven days of the *model's own* silence (`lastSeen`), not of the snapshot: a
 * read that mentions no new models must not keep an unrelated model alive.
 */
const ENTRY_TTL_MS = 7 * 24 * 3600_000
/** Modality order used across the catalog entries. */
const MODALITY_ORDER = ['text', 'image']
/**
 * Fields that are *not* cached.
 *
 * `credits` is a live rate (and promotions move it), so a value read an hour
 * ago is not a fallback — it is wrong. The cache stores no copy, and a cached
 * entry therefore reports no rate at all; the panel shows 未知 rather than a
 * stale number.
 *
 * `promotion` is a live *statement* rather than a measurement, and the cache is
 * append-only (a field another read omits is never cleared), so keeping it would
 * let an old claim outlive the payload that made it: the deployment's
 * `modelPromotions` block moves with each campaign, and a cached badge can
 * advertise a promotion that ended.
 *
 * `canDisableThinking` is retired — the plugin pins thinking on and never reads
 * the flag (protocol §4.3.1). It stays in this set only so that snapshots written
 * before the retirement drop it on read instead of leaving a dead field behind.
 */
const VOLATILE_FIELDS = new Set(['credits', 'promotion', 'canDisableThinking'])

function cacheDir() {
  return ensurePluginDir()
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
    const now = Date.now()
    return {
      // Volatile fields are dropped on read too: a snapshot written before they
      // were excluded must not leak a stale rate either. The admission policy is
      // applied as well — the cache appends, so an id excluded later has to be
      // filtered when reading.
      //
      // It is the *structural* half of the policy, not `keepModel`: that one also
      // demands a live credits rate, and rates are never cached. Applying it here
      // filtered out every entry a `/v3/config` read had produced, so the fallback
      // only worked for ids the account-scoped payload had touched too. What a cached
      // entry proves is that the deployment lists it — which is exactly what the cache
      // is for.
      //
      // The TTL is applied here as well as on write: an entry can sit unread for a
      // long time (the cache is only consulted when both live sources fail), and a
      // snapshot written before the TTL existed still holds entries that have since
      // gone silent.
      entries: parsed.entries
        .filter((entry) => isCatalogModelId(entry?.id))
        .map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !VOLATILE_FIELDS.has(key))))
        .filter((entry) => entry.preset !== true)
        .filter((entry) => now - (typeof entry.lastSeen === 'number' && Number.isFinite(entry.lastSeen) ? entry.lastSeen : parsed.savedAt) <= ENTRY_TTL_MS),
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
      const lastSeen = typeof entry.lastSeen === 'number' && Number.isFinite(entry.lastSeen) ? entry.lastSeen : previous.savedAt
      // Expiry is applied to the *previous* snapshot, so a model the deployment
      // stopped listing leaves on its own schedule rather than being resurrected
      // by the very read that dropped it.
      if (now - lastSeen > ENTRY_TTL_MS) continue
      byId.set(entry.id, {
        ...entry,
        firstSeen: typeof entry.firstSeen === 'number' ? entry.firstSeen : previous.savedAt,
        lastSeen
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
    // Staged inside the target directory: a temp file on another volume makes the
    // rename below fail with EXDEV, and by then the current file has already been moved.
    const staging = join(dir, `.catalog-${regionId}-${process.pid}.json`)
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
