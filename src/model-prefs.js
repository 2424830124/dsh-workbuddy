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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFS_VERSION = 1

function prefsDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'cache', 'dsh-workbuddy')
}

function prefsPath(regionId) {
  return join(prefsDir(), `enabled-${regionId}.json`)
}

const idSet = (value) => new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id.length > 0) : [])

/** @returns {{ on: Set<string>, off: Set<string>, updatedAt: number }} */
export function readPrefs(regionId) {
  try {
    const parsed = JSON.parse(readFileSync(prefsPath(regionId), 'utf8'))
    if (parsed?.version !== PREFS_VERSION) return { on: new Set(), off: new Set(), updatedAt: 0 }
    return {
      on: idSet(parsed.on),
      off: idSet(parsed.off),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return { on: new Set(), off: new Set(), updatedAt: 0 }
  }
}

function write(regionId, prefs) {
  try {
    mkdirSync(prefsDir(), { recursive: true })
    const staging = join(tmpdir(), `dsh-workbuddy-enabled-${regionId}-${process.pid}.json`)
    writeFileSync(staging, JSON.stringify({
      version: PREFS_VERSION,
      updatedAt: Date.now(),
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
 * @param {{ on: Set<string>, off: Set<string> }} prefs
 * @param {string} id
 * @param {boolean} unusable whether the availability ledger marked it dead
 */
export function isEnabled(prefs, id, unusable) {
  if (prefs.on.has(id)) return true
  if (prefs.off.has(id)) return false
  return !unusable
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
