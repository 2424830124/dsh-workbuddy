/**
 * Which models the user wants offered.
 *
 * The availability ledger says what *answers*; this says what the user wants in the picker.
 * They used to interact — the default followed the verdict, so anything the probe had not
 * condemned started out enabled. That made a fresh login look wrong in two ways: a
 * rate-limited model appeared enabled until the first probe relabelled it, and the user had to
 * switch it off by hand afterwards, one row at a time.
 *
 * So the default is now **off for everything**, and this file stores nothing but the ids the
 * user turned on. A model nobody touched is simply absent. Logging out does not touch that set:
 * the account may come back tomorrow, and re-picking forty switches by hand is not a feature.
 *
 * v3 adds `autoOff`: the ids the availability sweep suspended *while the user had them on*.
 * That is not a default either — it is the opposite end of the same decision. A model that
 * stops answering should leave the picker, but its verdict is not the user's opinion, so the
 * choice is kept and the suspension is recorded separately; when the model answers again the
 * suspension is lifted and the switch is exactly where the user left it. A model the user never
 * turned on is never suspended: it is already absent, and remembering it here would switch it
 * back on the moment its verdict cleared.
 *
 * File: `$DSH_HOME/dsh-workbuddy/enabled-<region>.json`
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensurePluginDir } from '../core/paths.js'

// v2 dropped the on/off pair for a single enabled set. A v1 file is migrated rather than
// discarded: its `on` list *is* the list of models the user deliberately enabled, while its
// `off` list only recorded disagreement with a default that no longer exists.
const PREFS_VERSION = 3

function prefsDir() {
  return ensurePluginDir()
}

function prefsPath(regionId) {
  return join(prefsDir(), `enabled-${regionId}.json`)
}

const idSet = (value) => new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : [])

/** @returns {{ enabled: Set<string>, autoOff: Set<string>, loggedOut: boolean, updatedAt: number }} */
export function readPrefs(regionId) {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(regionId), 'utf8'))
    if (parsed?.version === 1) {
      return { enabled: idSet(parsed.on), autoOff: new Set(), loggedOut: parsed.loggedOut === true, updatedAt: 0 }
    }
    // v2 had no `autoOff`: its enabled set was written before suspensions existed, so every
    // model in it was on because the user said so. Reading it as autoOff is the migration.
    if (parsed?.version !== PREFS_VERSION && parsed?.version !== 2) {
      return { enabled: new Set(), autoOff: new Set(), loggedOut: false, updatedAt: 0 }
    }
    return {
      enabled: idSet(parsed.enabled),
      autoOff: idSet(parsed.autoOff),
      loggedOut: parsed.loggedOut === true,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return { enabled: new Set(), autoOff: new Set(), loggedOut: false, updatedAt: 0 }
  }
}

function write(regionId, prefs) {
  try {
    mkdirSync(prefsDir(), { recursive: true })
    // Staged in the target directory so the rename cannot fail with EXDEV.
    const staging = join(prefsDir(), `.enabled-${regionId}-${process.pid}.json`)
    writeFileSync(staging, JSON.stringify({
      version: PREFS_VERSION,
      updatedAt: Date.now(),
      ...(prefs.loggedOut === true ? { loggedOut: true } : {}),
      enabled: [...prefs.enabled].sort(),
      ...(prefs.autoOff.size > 0 ? { autoOff: [...prefs.autoOff].sort() } : {})
    }))
    renameSync(staging, prefsPath(regionId))
    return true
  } catch {
    return false
  }
}

/**
 * Whether a model is offered.
 *
 * Off unless the user said otherwise; nothing is offered while the region is logged out, and
 * nothing is offered while the sweep has it suspended. Note what is *not* here: the verdict
 * itself. A caller cannot ask "is this model usable" — the suspension was written down when
 * the verdict was learned (`setAutoOff`), so this stays a question about the stored sets.
 *
 * @param {{ enabled: Set<string>, autoOff?: Set<string>, loggedOut?: boolean }} prefs
 * @param {string} id
 */
export function isEnabled(prefs, id) {
  if (prefs.loggedOut === true) return false
  if (prefs.autoOff?.has(id) === true) return false
  return prefs.enabled.has(id)
}

/**
 * Mark the region as logged out. The enabled set survives: it describes what the user chose,
 * not what the credentials currently allow.
 */
export function markLoggedOut(regionId) {
  const prefs = readPrefs(regionId)
  if (prefs.loggedOut === true) return { saved: true, alreadyOut: true }
  return { saved: write(regionId, { ...prefs, loggedOut: true }) }
}

/** Clear the logged-out marker; called when a login succeeds. */
export function clearLoggedOut(regionId) {
  const prefs = readPrefs(regionId)
  if (prefs.loggedOut !== true) return { saved: true }
  return { saved: write(regionId, { ...prefs, loggedOut: false }) }
}

/**
 * Record the user's choices.
 *
 * - `enabled: true|false` — add to / remove from the enabled set
 * - `reset: true` — clear it, which means "everything off", the default
 *
 * @returns {{ saved: boolean, on: number }} `on` is the size of the set now; there is no
 *   "off" count to report, because an id that is not in the set is simply off.
 */
export function setEnabled(regionId, ids, enabled, options = {}) {
  const prefs = readPrefs(regionId)
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    // Flipping a switch is an opinion, so it also cancels a suspension: the user is either
    // asking for the model (offer it, whatever the probe said) or refusing it (there is
    // nothing to restore later). Leaving it suspended would swallow the switch they just
    // flipped when the model recovers.
    if (options.reset === true) {
      prefs.enabled.delete(id)
      prefs.autoOff.delete(id)
      continue
    }
    if (enabled) prefs.enabled.add(id)
    else prefs.enabled.delete(id)
    prefs.autoOff.delete(id)
  }
  // Writing a choice also clears a stale logged-out marker, so a switch flipped while
  // logged out cannot stay hidden after the next login.
  return { saved: write(regionId, prefs), on: prefs.enabled.size }
}

/**
 * Record or lift the sweep's suspensions.
 *
 * `suspend` is only ever an id the user had enabled — a model nobody turned on needs no
 * suspension, and recording one would turn it back on the day its verdict clears. `resume`
 * is the other direction: an id whose verdict is no longer unusable comes back, which is
 * what makes the switch read the same before and after an outage.
 *
 * @param {string} regionId
 * @param {{ suspend?: string[], resume?: string[] }} changes
 * @returns {{ saved: boolean, suspended: number, resumed: number }}
 */
export function setAutoOff(regionId, changes = {}) {
  const prefs = readPrefs(regionId)
  let suspended = 0
  let resumed = 0
  for (const id of changes.suspend ?? []) {
    if (!prefs.enabled.has(id) || prefs.autoOff.has(id)) continue
    prefs.autoOff.add(id)
    suspended += 1
  }
  for (const id of changes.resume ?? []) {
    if (prefs.autoOff.delete(id)) resumed += 1
  }
  if (suspended === 0 && resumed === 0) return { saved: true, suspended: 0, resumed: 0 }
  return { saved: write(regionId, prefs), suspended, resumed }
}
