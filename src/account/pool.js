/**
 * Several signed-in accounts per deployment.
 *
 * The harness registers one provider per deployment and keys its adapters by that
 * provider string (`providerInfo(provider).id` must echo it), so a "pool" can only be
 * a storage arrangement behind one adapter — never extra providers. That is also why
 * an account is never shared between deployments: each adapter is handed its own
 * `region` object and never sees the other deployment's list.
 *
 * Account #1 *is* the region: its tokens live in `region.tokenRef` / `region.metaRef`,
 * which is what every install had before this file existed. Additional accounts get
 * suffixed refs (`<ref>#<id>`), so the first account keeps working with no migration,
 * and a downgraded plugin still finds its credentials where it always looked.
 *
 * The order in this file is the order the panel lists accounts in, and it is the order
 * a request falls back through: first account first, then the next one down.
 *
 * File: `$DSH_HOME/dsh-workbuddy/accounts-<region>.json`
 *   { version: 1, order: ['primary', 'acc-…'], accounts: { id: { nickname, uid, expiresAt, addedAt } } }
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { credentialRefs, ensurePluginDir, readCredential, unsetCredential } from '../core/paths.js'
import { REGIONS } from '../core/regions.js'


const POOL_VERSION = 1

/** The id of the account stored in the region's own refs. */
export const PRIMARY_ACCOUNT = 'primary'

/**
 * The bare deployment behind whatever region-shaped value was handed in.
 *
 * A slot is a region with one account's refs already attached, and every ref here is built by
 * appending to `region.tokenRef`: hand a slot to one of these functions and the ref comes out
 * suffixed twice, naming an account that does not exist. The logout path passes exactly that
 * (it works on the account being signed out), so the normalising happens at the edge instead
 * of depending on every caller remembering which argument a slot may not be.
 */
function baseRegion(region) {
  return REGIONS[region?.id] ?? region
}

function poolPath(regionId) {
  return join(ensurePluginDir(), `accounts-${regionId}.json`)
}

/** Anything that can be a credential ref is a JSON key, not a path — keep it readable. */
function safeId(raw) {
  // Long enough for a full uid (36 characters) — truncating one would cut a real account's
  // id in half and hand the same account two different refs on two logins.
  const value = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return value.length === 0 ? `acc-${Date.now().toString(36)}` : value
}

/** A stable id for a freshly signed-in account, derived from what upstream told us. */
export function newAccountId(seed) {
  const base = safeId(seed)
  return base === PRIMARY_ACCOUNT ? `acc-${Date.now().toString(36)}` : base
}

function readPool(regionId) {
  try {
    const parsed = JSON.parse(readFileSync(poolPath(regionId), 'utf8'))
    if (parsed?.version !== POOL_VERSION) return { order: [], accounts: {} }
    const accounts = typeof parsed.accounts === 'object' && parsed.accounts !== null ? parsed.accounts : {}
    const order = (Array.isArray(parsed.order) ? parsed.order : [])
      .filter((id) => typeof id === 'string' && id.length > 0 && Object.hasOwn(accounts, id))
    // An account stored without an order entry still exists; keep it, at the end.
    for (const id of Object.keys(accounts)) if (!order.includes(id)) order.push(id)
    return { order, accounts }
  } catch {
    return { order: [], accounts: {} }
  }
}

function writePool(regionId, pool) {
  try {
    mkdirSync(ensurePluginDir(), { recursive: true })
    // Staged in the target directory so the rename cannot fail with EXDEV.
    const staging = join(ensurePluginDir(), `.accounts-${regionId}-${process.pid}.json`)
    writeFileSync(staging, JSON.stringify({
      version: POOL_VERSION,
      order: pool.order,
      accounts: pool.accounts
    }, null, 2))
    renameSync(staging, poolPath(regionId))
    return true
  } catch {
    return false
  }
}

function readMetaRef(ref) {
  try {
    const value = readCredential(ref)
    if (value.length === 0) return undefined
    const meta = JSON.parse(value)
    return typeof meta === 'object' && meta !== null ? meta : undefined
  } catch {
    return undefined
  }
}

function readTokenRef(ref) {
  return readCredential(ref)
}

/**
 * The credential refs of one account.
 *
 * The primary account keeps the region's own refs — that is the no-migration part.
 */
export function refsFor(region, account) {
  region = baseRegion(region)
  if (account === undefined || account === null || account === PRIMARY_ACCOUNT) {
    return { tokenRef: region.tokenRef, metaRef: region.metaRef }
  }
  // The id is used verbatim. A ref is looked up by rebuilding it from the id, so an id that
  // gets rewritten on the way out names a ref nobody ever wrote: an older build stored
  // `<time>#<uid>` here, and sanitising that suffix produced a row with no nickname and no
  // token — a signed-in account that the panel could only show as unknown.
  const id = String(account)
  return { tokenRef: `${region.tokenRef}#${id}`, metaRef: `${region.metaRef}#${id}` }
}

/** A region-shaped object that reads and writes one account's credentials. */
export function slotFor(region, account) {
  region = baseRegion(region)
  const id = account === undefined || account === null ? PRIMARY_ACCOUNT : String(account)
  return { ...region, account: id, ...refsFor(region, id) }
}

/**
 * Every account of a deployment, in display order.
 *
 * Two sources, because an account is two things: an entry in the pool file (name,
 * order) and a token in the credential document. Either one can be missing — a pool
 * write can fail, and an install from before pools existed has only the credentials —
 * so the list is the union, and an account is only dropped when its token is gone.
 * That keeps "signed in but not indexed" visible instead of silently losing an account.
 *
 * A pool file that was never written still answers one account when the region's own
 * credentials exist: that is an install from before accounts could be added, and it
 * must keep showing up in the panel instead of looking signed out.
 */
export function listAccounts(region) {
  region = baseRegion(region)
  const pool = readPool(region.id)
  // The primary account always leads: its credentials are the deployment's own, and an
  // install that predates pools has only those. A pool file missing it (written before
  // the first account was indexed) must not push it to the end of the fallback order.
  const order = [PRIMARY_ACCOUNT, ...pool.order.filter((id) => id !== PRIMARY_ACCOUNT)]
  // Tokens that exist but were never indexed (a failed write, an older build). The id is
  // taken exactly as it appears in the ref, because that is what resolves back to the
  // account: anything else names a ref that was never written.
  const prefix = `${region.tokenRef}#`
  for (const ref of credentialRefs()) {
    if (!ref.startsWith(prefix)) continue
    const id = ref.slice(prefix.length)
    if (id.length === 0 || order.includes(id)) continue
    order.push(id)
  }
  if (order.length > 0) {
    const entries = order.map((id) => {
      const meta = readMetaRef(refsFor(region, id).metaRef) ?? {}
      const token = readTokenRef(refsFor(region, id).tokenRef)
      return {
        id,
        nickname: typeof pool.accounts[id]?.nickname === 'string' ? pool.accounts[id].nickname : (typeof meta.nickname === 'string' ? meta.nickname : ''),
        uid: typeof pool.accounts[id]?.uid === 'string' ? pool.accounts[id].uid : (typeof meta.uid === 'string' ? meta.uid : ''),
        expiresAt: typeof pool.accounts[id]?.expiresAt === 'number' ? pool.accounts[id].expiresAt : (typeof meta.expiresAt === 'number' ? meta.expiresAt : 0),
        addedAt: typeof pool.accounts[id]?.addedAt === 'number'
          ? pool.accounts[id].addedAt
          : (typeof meta.updatedAt === 'number' ? meta.updatedAt : 0),
        loggedIn: token.length > 0
      }
    })
    // One person, one row. The same account signed in twice lands under two ids (that is
    // what an add looks like when the id was built from the clock instead of from the
    // identity upstream reports), and two rows for one account can never both answer: the
    // fallback would try the same credentials twice and report the same failure on each.
    //
    // A token decides first, because an id without one is not an account: it cannot answer a
    // request and it cannot be signed out, so a row built from it reads 未登录 forever while
    // the credentials sit right next to it under the other id. Being in the pool file only
    // breaks the tie between two ids that both hold a token — then the indexed one wins, and
    // otherwise the most recent.
    const best = (a, b) => {
      if (a.loggedIn !== b.loggedIn) return a.loggedIn ? a : b
      const indexed = pool.order.includes(b.id) !== pool.order.includes(a.id)
      if (indexed) return pool.order.includes(a.id) ? a : b
      return a.addedAt >= b.addedAt ? a : b
    }
    const byUid = new Map()
    for (const entry of entries) {
      if (entry.uid.length === 0) continue
      const previous = byUid.get(entry.uid)
      byUid.set(entry.uid, previous === undefined ? entry : best(previous, entry))
    }
    const dropped = new Set()
    for (const entry of entries) {
      if (entry.uid.length === 0) continue
      if (byUid.get(entry.uid).id !== entry.id) dropped.add(entry.id)
    }
    return entries
      .filter((entry) => !dropped.has(entry.id))
      // An account exists when its credentials do. A pool entry nobody can read a token for is
      // not an account: it cannot answer a request and it cannot be signed out, so a row for it
      // can only ever read 未知 / 未登录 — which is what a leftover from a failed or older write
      // looked like in the panel, with no way to make it go away.
      .filter((entry) => entry.loggedIn)
  }
  if (readTokenRef(region.tokenRef).length === 0) return []
  const meta = readMetaRef(region.metaRef) ?? {}
  return [{
    id: PRIMARY_ACCOUNT,
    nickname: typeof meta.nickname === 'string' ? meta.nickname : '',
    uid: typeof meta.uid === 'string' ? meta.uid : '',
    expiresAt: typeof meta.expiresAt === 'number' ? meta.expiresAt : 0,
    addedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
    loggedIn: true
  }]
}

/** Region-shaped slots, one per account, in display order. */
export function accountSlots(region) {
  region = baseRegion(region)
  const accounts = listAccounts(region)
  if (accounts.length === 0) return [slotFor(region, PRIMARY_ACCOUNT)]
  return accounts.map((entry) => slotFor(region, entry.id))
}

/**
 * The uid one account reports, read from the pool file or from its own metadata.
 *
 * It is the only thing two ids for one person have in common; the ids themselves are whatever
 * the build that wrote them decided to call the account.
 */
function uidOf(region, pool, id) {
  const stored = pool.accounts[id]?.uid
  if (typeof stored === 'string' && stored.length > 0) return stored
  const meta = readMetaRef(refsFor(region, id).metaRef)
  return typeof meta?.uid === 'string' ? meta.uid : ''
}

/**
 * The other ids that carry the same upstream identity.
 *
 * `scanCredentials` looks past the pool file, because the id that holds the token is not
 * always the id the pool indexed — and that leftover is exactly what rebuilds a row after it
 * was removed.
 */
function siblingIds(region, pool, id, uid, options = {}) {
  const ids = new Set()
  if (uid.length === 0) return ids
  for (const [candidate, entry] of Object.entries(pool.accounts)) {
    if (candidate !== id && entry?.uid === uid) ids.add(candidate)
  }
  if (options.scanCredentials !== true) return ids
  const prefix = `${region.tokenRef}#`
  for (const ref of credentialRefs()) {
    if (!ref.startsWith(prefix)) continue
    const candidate = ref.slice(prefix.length)
    if (candidate === id || ids.has(candidate)) continue
    if (readMetaRef(`${region.metaRef}#${candidate}`)?.uid === uid) ids.add(candidate)
  }
  return ids
}

/** Remember (or update) one account and keep it in the pool's order. */
export function registerAccount(region, entry) {
  region = baseRegion(region)
  const pool = readPool(region.id)
  const uidGiven = typeof entry.uid === 'string' ? entry.uid : ''
  // An identity that is already in the pool keeps its existing entry and its place in the
  // order: signing the same account in again refreshes it, and a second id for one person
  // would otherwise show up as two accounts that can never both answer.
  let id = entry.id === undefined || entry.id === null ? PRIMARY_ACCOUNT : String(entry.id)
  if (uidGiven.length > 0) {
    // The identity may exist as a pool entry *or* only as credentials (an account that
    // was discovered rather than indexed), so both are consulted.
    for (const known of listAccounts(region)) {
      if (known.id !== id && known.uid === uidGiven) { id = known.id; break }
    }
  }
  // One entry per identity: a sibling id left over from an earlier login names the same
  // person, and the file only has to stay big enough to describe the accounts that exist.
  for (const sibling of siblingIds(region, pool, id, uidGiven)) {
    pool.order = pool.order.filter((candidate) => candidate !== sibling)
    delete pool.accounts[sibling]
  }
  // Housekeeping, because this is already a write: an entry nobody holds a token for names an
  // account that is not signed in, and the read path will not show it either. Keeping it would
  // be carrying a row's worth of dead metadata for every logout that ever half-finished.
  for (const candidate of Object.keys(pool.accounts)) {
    if (candidate === id) continue
    if (readTokenRef(refsFor(region, candidate).tokenRef).length > 0) continue
    pool.order = pool.order.filter((other) => other !== candidate)
    delete pool.accounts[candidate]
  }
  const previous = pool.accounts[id] ?? {}
  pool.accounts[id] = {
    nickname: typeof entry.nickname === 'string' && entry.nickname.length > 0 ? entry.nickname : (previous.nickname ?? ''),
    uid: uidGiven.length > 0 ? uidGiven : (previous.uid ?? ''),
    expiresAt: typeof entry.expiresAt === 'number' && entry.expiresAt > 0 ? entry.expiresAt : (previous.expiresAt ?? 0),
    addedAt: typeof previous.addedAt === 'number' && previous.addedAt > 0 ? previous.addedAt : (typeof entry.addedAt === 'number' ? entry.addedAt : Date.now())
  }
  if (!pool.order.includes(id)) pool.order.push(id)
  return { saved: writePool(region.id, pool), id, order: pool.order }
}

/**
 * Drop one account: its credentials first, then its pool entry.
 *
 * Every id carrying that account's identity goes with it, including one the pool never
 * indexed. Deleting only the row would leave its token on disk, and the next read would
 * build the row again from the credential document — 退出登录 has to stick.
 */
export function removeAccount(region, account) {
  region = baseRegion(region)
  const id = String(account)
  const pool = readPool(region.id)
  const uid = uidOf(region, pool, id)
  const victims = [id, ...siblingIds(region, pool, id, uid, { scanCredentials: true })]
  for (const victim of victims) {
    const refs = refsFor(region, victim)
    unsetCredential(refs.tokenRef)
    unsetCredential(refs.metaRef)
    pool.order = pool.order.filter((candidate) => candidate !== victim)
    delete pool.accounts[victim]
  }
  return { saved: writePool(region.id, pool), id, removed: victims }
}
