/**
 * Where this plugin keeps everything it owns.
 *
 * One directory, `$DSH_HOME/dsh-workbuddy/`: credentials, the catalog cache, the
 * availability ledger, per-model switches and the imported account list. Keeping them
 * together means "reset the plugin" is one folder to delete, and nothing of ours hides
 * inside the harness's own `cache/` tree.
 *
 * Credentials are written here rather than through the harness credentials service: that
 * service keeps a single document for every plugin, and this plugin's tokens have no
 * business sharing a file — or a ref namespace — with anything else.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** `$DSH_HOME`, falling back to `~/.dsh` the same way the harness does. */
function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** The plugin's own directory. */
export function pluginDir() {
  return join(dshHome(), 'dsh-workbuddy')
}

/** Absolute path of a file inside {@link pluginDir}. */
export function pluginFile(name) {
  return join(pluginDir(), name)
}

/** Create the directory (owner-only) and return it. */
export function ensurePluginDir() {
  const dir = pluginDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Read a JSON file from the plugin directory, or `undefined` when it is missing or
 * unreadable. A corrupt file reads as absent: a broken cache must never break a start.
 */
export function readJson(name) {
  try {
    return JSON.parse(readFileSync(pluginFile(name), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write a JSON file atomically: staged inside the directory (a temp file on another
 * volume makes `rename` fail with EXDEV), then renamed over the target.
 */
export function writeJson(name, value, options = {}) {
  const dir = ensurePluginDir()
  const target = pluginFile(name)
  const staging = join(dir, `.${name}.${process.pid}.tmp`)
  writeFileSync(staging, JSON.stringify(value, null, options.pretty === true ? 2 : 0), { mode: 0o600 })
  renameSync(staging, target)
  if (options.mode !== undefined) chmodSync(target, options.mode)
  return target
}

/**
 * Credentials, kept as one small JSON document: `{ [ref]: value }`.
 *
 * Values are opaque strings — an access token, or a JSON blob of refresh metadata — so
 * this file needs no schema. Reads tolerate a missing file; writes are atomic and 0600.
 */
const CREDENTIALS_FILE = 'credentials.json'

function readAllCredentials() {
  const parsed = readJson(CREDENTIALS_FILE)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

/** One credential value, or `''` when absent. */
export function readCredential(ref) {
  const value = readAllCredentials()[ref]
  return typeof value === 'string' ? value : ''
}

/**
 * The credentials-service shape (`{ value, source, writable }`) so the call sites that
 * expect it keep working, but reading from this plugin's own document.
 */
export function resolveCredential(ref) {
  const value = readCredential(ref)
  return value.length === 0 ? undefined : { value, source: 'stored', writable: true }
}

/** Store one credential value. An empty value is refused — use {@link unsetCredential}. */
export function setCredential(ref, value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`refusing to store an empty credential for ${ref}`)
  const all = readAllCredentials()
  all[ref] = value
  writeJson(CREDENTIALS_FILE, all, { mode: 0o600 })
}

/** Delete one credential; a missing one is not an error. */
export function unsetCredential(ref) {
  const all = readAllCredentials()
  if (!(ref in all)) return
  delete all[ref]
  writeJson(CREDENTIALS_FILE, all, { mode: 0o600 })
}

/** Whether the credentials document exists at all (used by the panel's wording). */
export function hasCredentialsFile() {
  return existsSync(pluginFile(CREDENTIALS_FILE))
}

export { dirname }
