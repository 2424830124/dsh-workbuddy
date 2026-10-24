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
 * File: `$DSH_HOME/dsh-workbuddy/enabled-<region>.json`
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensurePluginDir } from '../core/paths.js'

// v2 dropped the on/off pair for a single enabled set. A v1 file is migrated rather than
// discarded: its `on` list *is* the list of models the user deliberately enabled, while its
// `off` list only recorded disagreement with a default that no longer exists.
const PREFS_VERSION = 2

function prefsDir() {
  return ensurePluginDir()
}

function prefsPath(regionId) {
  return join(prefsDir(), `enabled-${regionId}.json`)
}

const idSet = (value) => new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : [])

/** @returns {{ enabled: Set<string>, loggedOut: boolean, updatedAt: number }} */
export function readPrefs(regionId) {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(regionId), 'utf8'))
    if (parsed?.version === 1) {
      return { enabled: idSet(parsed.on), loggedOut: parsed.loggedOut === true, updatedAt: 0 }
    }
    if (parsed?.version !== PREFS_VERSION) return { enabled: new Set(), loggedOut: false, updatedAt: 0 }
    return {
      enabled: idSet(parsed.enabled),
      loggedOut: parsed.loggedOut === true,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return { enabled: new Set(), loggedOut: false, updatedAt: 0 }
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
      enabled: [...prefs.enabled].sort()
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
 * Off unless the user said otherwise, and nothing is offered while the region is logged out —
 * the picker must not advertise models no credential can reach, and that is a presentation
 * state rather than a change to the set.
 *
 * @param {{ enabled: Set<string>, loggedOut?: boolean }} prefs
 * @param {string} id
 */
export function isEnabled(prefs, id) {
  if (prefs.loggedOut === true) return false
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
 * @returns {{ saved: boolean, on: number, off: number }} `on` is the size of the set now,
 *   `off` no longer has a stored meaning and stays 0 so callers keep working.
 */
export function setEnabled(regionId, ids, enabled, options = {}) {
  const prefs = readPrefs(regionId)
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (options.reset === true) {
      prefs.enabled.delete(id)
      continue
    }
    if (enabled) prefs.enabled.add(id)
    else prefs.enabled.delete(id)
  }
  // A hand decision is also a login-scoped state: writing it clears the stale marker so a
  // switch flipped while logged out cannot stay hidden after the next login.
  return { saved: write(regionId, prefs), on: prefs.enabled.size, off: 0 }
}
