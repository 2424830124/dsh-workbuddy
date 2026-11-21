/**
 * Unit check for the automatic daily check-in across the account pool.
 *
 * The bug this pins: `runAutoClaim` walked deployments and handed the bare region to
 * `claimDailyCheckin`, which resolves a region-shaped argument through `usableSlot` —
 * exactly one slot. Every deployment therefore claimed for one account only, and the
 * request still succeeded, so nothing looked broken.
 *
 * Run: `node test/unit/credits.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-credits-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { runAutoClaim } = await import('../../src/account/credits.js')
const { setCredential, readCredential } = await import('../../src/core/paths.js')
const { REGIONS } = await import('../../src/core/regions.js')
const { slotFor, PRIMARY_ACCOUNT } = await import('../../src/account/pool.js')

const cn = REGIONS.cn
const intl = REGIONS.intl
const now = Date.now()

// Two signed-in accounts of the mainland deployment. A recent `updatedAt` keeps
// `freshToken` from rotating them, so the only network call is the claim itself.
setCredential(cn.tokenRef, 'primary.token.value')
setCredential(cn.metaRef, JSON.stringify({ refreshToken: 'r1', expiresAt: now + 3600_000, uid: 'u1', nickname: '示例账号', updatedAt: now }))

const second = slotFor(cn, 'acc-b')
setCredential(second.tokenRef, 'second.token.value')
setCredential(second.metaRef, JSON.stringify({ refreshToken: 'r2', expiresAt: now + 3600_000, uid: 'u2', nickname: '副账号', updatedAt: now }))

// The overseas deployment has no check-in endpoint; a token there proves it is skipped.
setCredential(intl.tokenRef, 'intl.token.value')
setCredential(intl.metaRef, JSON.stringify({ refreshToken: 'r3', expiresAt: now + 3600_000, uid: 'u3', nickname: '示例账号', updatedAt: now }))

/** Every claim request, with the bearer token it carried. */
const claims = []
globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  if (target.includes('/billing/meter/daily-checkin')) {
    claims.push({ url: target, token: String(init.headers?.Authorization ?? '') })
    return new Response(JSON.stringify({ code: 0, data: { credit: 50, streak_days: 4 } }), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${target}`)
}

const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} } }

const outcomes = await runAutoClaim(ctx, '启动')

assert.equal(claims.length, 2, 'every account of a deployment is claimed, not just the first one')
assert.deepEqual(
  claims.map((entry) => entry.token).sort(),
  ['Bearer primary.token.value', 'Bearer second.token.value'],
  'each claim carries its own account credentials'
)

assert.equal(outcomes.length, 2)
assert.deepEqual(outcomes.map((entry) => entry.account).sort(), [PRIMARY_ACCOUNT, 'acc-b'].sort())
assert.ok(outcomes.every((entry) => entry.region === 'cn'))
assert.ok(outcomes.every((entry) => entry.claimed === true && entry.credit === 50))

// The outcome is remembered per account, which is what the panel row shows.
const primaryMeta = JSON.parse(readCredential(cn.metaRef))
const secondMeta = JSON.parse(readCredential(second.metaRef))
assert.equal(primaryMeta.checkin.credit, 50)
assert.equal(primaryMeta.checkin.reason, '启动')
assert.equal(secondMeta.checkin.credit, 50, 'the added account records its own claim')

// A second pass reports the same accounts again (the server is idempotent), and still
// never touches the deployment without a check-in endpoint.
claims.length = 0
const again = await runAutoClaim(ctx, '午夜')
assert.equal(claims.length, 2)
assert.equal(again.length, 2)
assert.ok(claims.every((entry) => !entry.url.includes('workbuddy.ai')), 'the overseas deployment is not claimed')

console.log('credits.mjs: OK — every pooled account is claimed on its own credentials, outcomes are remembered per account, and a deployment without a check-in endpoint is skipped')
