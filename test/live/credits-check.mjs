/**
 * Manual check of the credits/check-in paths against the real China gateway.
 *
 * Requires `test/.token` (written during development). Run:
 * `node test/credits-check.mjs`
 */

import { readFileSync } from 'node:fs'
import { fetchCheckinStatus, fetchCredits, claimDailyCheckin } from '../../src/account/credits.js'
import { REGIONS } from '../../src/core/regions.js'

const token = JSON.parse(readFileSync(new URL('../.token', import.meta.url), 'utf8'))
const store = new Map([
  [REGIONS.cn.tokenRef, token.accessToken],
  [REGIONS.cn.metaRef, JSON.stringify({ refreshToken: token.refreshToken, domain: token.domain })]
])

const ctx = {
  logger: { info: (...args) => console.log('[info]', ...args), warn: (...args) => console.warn('[warn]', ...args) },
  credentials: {
    resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
    set: async (ref, value) => { store.set(ref, value) }
  }
}

const credits = await fetchCredits(ctx, REGIONS.cn)
console.log('credits:', JSON.stringify(credits, null, 1).slice(0, 1200))

const status = await fetchCheckinStatus(ctx, REGIONS.cn)
console.log('checkin status:', JSON.stringify(status))

const claim = await claimDailyCheckin(ctx, REGIONS.cn)
console.log('claim:', JSON.stringify(claim))

console.log('intl checkin supported:', JSON.stringify(await fetchCheckinStatus(ctx, REGIONS.intl)))
