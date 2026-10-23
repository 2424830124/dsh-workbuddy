/**
 * Per-model enable/disable preferences.
 *
 * The availability ledger says what *answers*; this says what the user wants
 * offered. They are deliberately separate:
 *
 * - **Default follows the verdict** — a model the probe could not reach is off,
 *   a working one is on. Nobody has to curate a list to get a sane picker.
 * - **A hand decision always wins** — turning an unusable model on is exactly
 *   how a curious user tries it, and turning a working one off keeps the picker
 *   short.
 *
 * Only the hand decisions are stored, as two id sets, so a model that shows up
 * in the catalog tomorrow simply follows its own verdict instead of silently
 * appearing or missing.
 *
 * File: `$DSH_HOME/cache/dsh-workbuddy/enabled-<region>.json`
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ensurePluginDir } from '../core/paths.js'

const PREFS_VERSION = 1

function prefsDir() {
  return ensurePluginDir()
}

function prefsPath(regionId) {
  return join(prefsDir(), `enabled-${regionId}.json`)
}

const idSet = (value) => new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : [])

/** @returns {{ on: Set<string>, off: Set<string>, loggedOut: boolean, updatedAt: number }} */
export function readPrefs(regionId) {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(regionId), 'utf8'))
    if (parsed?.version !== PREFS_VERSION) return { on: new Set(), off: new Set(), loggedOut: false, updatedAt: 0 }
    return {
      on: idSet(parsed.on),
      off: idSet(parsed.off),
      loggedOut: parsed.loggedOut === true,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return { on: new Set(), off: new Set(), loggedOut: false, updatedAt: 0 }
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
      on: [...prefs.on].sort(),
      off: [...prefs.off].sort()
    }))
    renameSync(staging, prefsPath(regionId))
    return true
  } catch {
    return false
  }
}

/**
 * Whether a model is offered, given the hand decisions and its verdict.
 *
 * A region that is logged out offers nothing: the picker must not keep advertising models
 * the account can no longer call, and with no credentials the verdicts are meaningless
 * anyway. `readPrefs` reports that state, and this is the single place it is honoured.
 *
 * @param {{ on: Set<string>, off: Set<string>, loggedOut?: boolean }} prefs
 * @param {string} id
 * @param {boolean} unusable whether the availability ledger marked it dead
 */
export function isEnabled(prefs, id, unusable) {
  if (prefs.loggedOut === true) return false
  if (prefs.on.has(id)) return true
  if (prefs.off.has(id)) return false
  return !unusable
}

/**
 * Mark the region as logged out, which hides every model from the picker until a login
 * clears it. Not the same as disabling each id: that would be a pile of hand decisions the
 * user never made, and would survive the next login.
 */
export function markLoggedOut(regionId) {
  const prefs = readPrefs(regionId)
  if (prefs.loggedOut === true) return { saved: true, alreadyOut: true }
  return { saved: write(regionId, { ...prefs, loggedOut: true, on: new Set(), off: new Set() }) }
}

/** Clear the logged-out marker; called when a login succeeds. */
export function clearLoggedOut(regionId) {
  const prefs = readPrefs(regionId)
  if (prefs.loggedOut !== true) return { saved: true }
  return { saved: write(regionId, { ...prefs, loggedOut: false }) }
}

/**
 * Record hand decisions.
 *
 * - `enabled: true|false` — an explicit choice for these ids
 * - `reset: true` — forget the choice, so the verdict decides again
 *
 * @returns {{ saved: boolean, on: number, off: number }}
 */
export function setEnabled(regionId, ids, enabled, options = {}) {
  const prefs = readPrefs(regionId)
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (options.reset === true) {
      prefs.on.delete(id)
      prefs.off.delete(id)
      continue
    }
    if (enabled) {
      prefs.on.add(id)
      prefs.off.delete(id)
    } else {
      prefs.off.add(id)
      prefs.on.delete(id)
    }
  }
  return { saved: write(regionId, prefs), on: prefs.on.size, off: prefs.off.size }
}
