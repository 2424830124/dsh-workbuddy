/**
 * Unit check for the account pool: several accounts per deployment, and the fallback
 * path a chat request takes when one of them cannot answer.
 *
 * The rules being pinned:
 *
 *   1. the deployment's own credentials are account #1 and need no migration;
 *   2. an added account gets its own refs, keeps the order it was added in, and that
 *      order is the fallback order;
 *   3. a request that fails with a balance/window/throttle/credential failure moves to
 *      the next account, while a failure another account cannot fix (a delisted model)
 *      is thrown at once without trying the second one;
 *   4. a mainland request never reaches an overseas account — the two pools are separate
 *      by construction, and this asserts it.
 *
 * Run: `node test/unit/pool.mjs`
 */

import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-pool-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { listAccounts, registerAccount, removeAccount, accountSlots, PRIMARY_ACCOUNT, slotFor } = await import('../../src/account/pool.js')
const { setCredential, readCredential, unsetCredential } = await import('../../src/core/paths.js')
const { REGIONS } = await import('../../src/core/regions.js')
const { WorkBuddyAdapter } = await import('../../src/llm/adapter.js')

const cn = REGIONS.cn
const intl = REGIONS.intl

// ---------------------------------------------------------------------------
// 1. The deployment's own credentials are account #1.
// ---------------------------------------------------------------------------

assert.deepEqual(listAccounts(cn), [], 'with no credentials there is no account at all')

setCredential(cn.tokenRef, 'header.payload.signature')
setCredential(cn.metaRef, JSON.stringify({ refreshToken: 'r1', expiresAt: Date.now() + 3600_000, uid: 'u1', nickname: '示例账号', updatedAt: Date.now() }))

const first = listAccounts(cn)
assert.equal(first.length, 1, 'the pre-existing login reads back as one account')
assert.equal(first[0].id, PRIMARY_ACCOUNT, 'and it is the primary one')
assert.equal(first[0].nickname, '示例账号')
assert.equal(first[0].loggedIn, true, 'a stored token is a signed-in account')
assert.equal(first[0].uid, 'u1')
// The primary account's refs are the deployment's own — that is the no-migration part.
assert.deepEqual(slotFor(cn, PRIMARY_ACCOUNT), { ...cn, account: PRIMARY_ACCOUNT })

// ---------------------------------------------------------------------------
// 2. Adding accounts: own refs, append-only order, no duplicate identity.
// ---------------------------------------------------------------------------

const second = slotFor(cn, 'acc-b')
assert.notEqual(second.tokenRef, cn.tokenRef, 'an added account has its own token ref')
assert.equal(second.tokenRef, `${cn.tokenRef}#acc-b`)
assert.equal(second.metaRef, `${cn.metaRef}#acc-b`)
assert.equal(second.id, cn.id, 'but it belongs to the same deployment')

setCredential(second.tokenRef, 'second.token.value')
setCredential(second.metaRef, JSON.stringify({ refreshToken: 'r2', expiresAt: Date.now() + 3600_000, uid: 'u2', nickname: '副账号', updatedAt: Date.now() }))

const ordered = listAccounts(cn)
assert.deepEqual(ordered.map((entry) => entry.id), [PRIMARY_ACCOUNT, 'acc-b'], 'the pool keeps the order accounts were added in')
assert.deepEqual(ordered.map((entry) => entry.nickname), ['示例账号', '副账号'])

// Signing the same upstream identity in again must not leave two entries behind.
registerAccount(cn, { id: 'acc-c', nickname: '同一个人的另一台设备', uid: 'u2', expiresAt: Date.now() + 3600_000 })
assert.deepEqual(listAccounts(cn).map((entry) => entry.id), [PRIMARY_ACCOUNT, 'acc-b'], 'the same uid replaces its previous entry rather than adding a duplicate')

// Slots are what every read and every request iterate.
assert.deepEqual(accountSlots(cn).map((slot) => slot.account), [PRIMARY_ACCOUNT, 'acc-b'])
assert.equal(accountSlots(cn)[1].tokenRef, `${cn.tokenRef}#acc-b`)

// Removing one account leaves its sibling's credentials alone.
removeAccount(cn, 'acc-b')
unsetCredential(second.tokenRef)
unsetCredential(second.metaRef)
assert.deepEqual(listAccounts(cn).map((entry) => entry.id), [PRIMARY_ACCOUNT], 'removing an account drops only that entry')
assert.equal(readCredential(cn.tokenRef).length > 0, true, 'the primary account still holds its token')

// ---------------------------------------------------------------------------
// 2b. Credentials an older build wrote still resolve, and one identity signing
//     in twice is still one account.
// ---------------------------------------------------------------------------

// The earlier shape put the uid in the id, so the ref carried two `#`. Sanitising such an id
// rebuilt a ref that no longer matched the file on disk, and the account came back as a row
// with no nickname and no token — the id has to be taken from the ref verbatim.
const legacyOlder = '1700000000000#3f2b9c18-6d47-4a1e-9b0c-5e2d7a4f8b31'
const legacyNewer = '1700000600000#3f2b9c18-6d47-4a1e-9b0c-5e2d7a4f8b31'
const legacyUid = '3f2b9c18-6d47-4a1e-9b0c-5e2d7a4f8b31'
for (const [id, token, updatedAt] of [[legacyOlder, 'legacy.older.token', 1], [legacyNewer, 'legacy.newer.token', 2]]) {
  setCredential(`${cn.tokenRef}#${id}`, token)
  setCredential(`${cn.metaRef}#${id}`, JSON.stringify({ nickname: '示例小号', uid: legacyUid, updatedAt }))
}

const withLegacy = listAccounts(cn)
assert.equal(withLegacy.length, 2, 'an account the older build added is an account, not a ghost row')
const legacy = withLegacy[1]
assert.equal(legacy.id, legacyNewer, 'the newest sign-in of that identity is the one kept')
assert.equal(legacy.nickname, '示例小号', 'and its metadata reads back, which is what the row shows')
assert.equal(legacy.loggedIn, true, 'its token is still there')
assert.equal(slotFor(cn, legacy.id).tokenRef, `${cn.tokenRef}#${legacyNewer}`, 'asking for the account gives back the ref it was found at')

for (const id of [legacyOlder, legacyNewer]) {
  unsetCredential(`${cn.tokenRef}#${id}`)
  unsetCredential(`${cn.metaRef}#${id}`)
}
assert.deepEqual(listAccounts(cn).map((entry) => entry.id), [PRIMARY_ACCOUNT], 'and clearing them leaves the pool as it was')

// The exact shape one of those builds left behind on a real install: the pool file indexes
// the bare upstream uid while the credentials were written under `<login time>#<uid>`. The
// indexed id holds no token, so preferring "the indexed one" would show a 未登录 row right
// next to the working credentials — a token decides first.
const orphanId = '3f2b9c18-6d47-4a1e-9b0c-5e2d7a4f8b31'
const holderId = `1700001200000#${orphanId}`
// The pool entry first, the credentials under the other id afterwards — the file on his disk
// has them in that state, and nothing rewrites it until the account is touched again.
registerAccount(cn, { id: orphanId, nickname: '示例小号', uid: orphanId })
setCredential(`${cn.tokenRef}#${holderId}`, 'holder.token')
setCredential(`${cn.metaRef}#${holderId}`, JSON.stringify({ nickname: '示例小号', uid: orphanId, updatedAt: Date.now() }))

const diverged = listAccounts(cn)
assert.equal(diverged.length, 2, 'the identity is one row, not one row per id it was written under')
assert.equal(diverged[1].id, holderId, 'the id holding the token is the one that answers')
assert.equal(diverged[1].loggedIn, true, 'so the row is signed in, not 未登录')
assert.equal(diverged[1].nickname, '示例小号', 'and it still reads as the account it is')

const removed = removeAccount(cn, holderId)
assert.deepEqual([...removed.removed].sort(), [orphanId, holderId].sort(), 'removing it takes every id of that identity')
assert.equal(readCredential(`${cn.tokenRef}#${holderId}`), '', 'and its credentials, or the next read rebuilds the row')
assert.deepEqual(listAccounts(cn).map((entry) => entry.id), [PRIMARY_ACCOUNT], 'nothing of it comes back')

// The other half of that leftover: a pool entry whose credentials are gone — what signing an
// account out used to leave behind — is not an account any more. A row for it could only read
// 未知 / 未登录, and no click could remove it.
registerAccount(cn, { id: '100000003', nickname: '残留账号', uid: '100000003' })
assert.deepEqual(listAccounts(cn).map((entry) => entry.id), [PRIMARY_ACCOUNT], 'an entry without credentials is not an account')

// The read path hides it, so the file has to be looked at directly for the other half of the
// rule: the next write drops it, and one logout per login cannot pile these up forever.
setCredential(`${cn.tokenRef}#100000004`, 'header.payload.signature')
registerAccount(cn, { id: '100000004', nickname: '新账号', uid: '100000004' })
const poolFile = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-workbuddy', `accounts-${cn.id}.json`), 'utf8'))
assert.equal(poolFile.accounts['100000003'], undefined, 'a tokenless entry is dropped when the pool is rewritten')
assert.equal(poolFile.order.includes('100000003'), false, 'and leaves the fallback order with it')

unsetCredential(`${cn.tokenRef}#100000004`)
removeAccount(cn, '100000004')
assert.deepEqual(listAccounts(cn).map((entry) => entry.id), [PRIMARY_ACCOUNT], 'and the pool is back where it was')

// ---------------------------------------------------------------------------
// 3. Fallback on a request: the same payload, the next account.
// ---------------------------------------------------------------------------

/**
 * A chat request that answers differently per bearer token.
 *
 * `answers` maps an account's token to the response it must produce; a token with no
 * entry is a test bug, so the call throws instead of silently succeeding.
 */
async function attempt(answers, model = 'deepseek-v4.1-flash-sg') {
  setCredential(cn.tokenRef, 'token-primary')
  setCredential(cn.metaRef, JSON.stringify({ refreshToken: 'r', expiresAt: Date.now() + 3600_000, uid: 'u1', nickname: '主号', updatedAt: Date.now() }))
  const slot = slotFor(cn, 'acc-b')
  setCredential(slot.tokenRef, 'token-second')
  setCredential(slot.metaRef, JSON.stringify({ refreshToken: 'r', expiresAt: Date.now() + 3600_000, uid: 'u2', nickname: '副号', updatedAt: Date.now() }))
  registerAccount(cn, { id: 'acc-b', nickname: '副号', uid: 'u2', expiresAt: Date.now() + 3600_000 })

  const seen = []
  globalThis.fetch = async (url, init) => {
    const authorization = String(init?.headers?.Authorization ?? '')
    seen.push(authorization.replace('Bearer ', ''))
    const answer = answers[authorization.replace('Bearer ', '')]
    if (answer === undefined) throw new Error(`unexpected account ${authorization}`)
    return answer()
  }

  const adapter = new WorkBuddyAdapter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    credentials: { resolve: async () => undefined },
    get: () => undefined
  }, cn)
  adapter.catalog = []
  adapter.catalogAt = Date.now()

  let failure
  let text = ''
  try {
    for await (const chunk of adapter.stream({
      provider: '@huai_xin/dsh-workbuddy/cn',
      model,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: AbortSignal.timeout(10_000)
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
  } catch (error) {
    failure = error
  }
  return { failure, text, seen, adapter }
}

const sse = (text) => () => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder()
    controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`))
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller.close()
  }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const creditsExhausted = () => new Response(JSON.stringify({
  error: { data: { code: 14018, msg: 'Credits exhausted.' } }
}), { status: 429, headers: { 'content-type': 'application/json' } })

const rateWindow = () => new Response(JSON.stringify({
  code: 429,
  msg: "usage exceeds frequency limit, your usage will reset at 2026-10-24 09:54:53 UTC+8"
}), { status: 429, headers: { 'content-type': 'application/json' } })

const modelGone = () => new Response(JSON.stringify({
  error: { data: { code: 11102, msg: 'service info not found' } }
}), { status: 400, headers: { 'content-type': 'application/json' } })

const queued = () => new Response(JSON.stringify({
  code: 6020,
  msg: 'queue.waiting.title',
  data: { queue_position: 3 }
}), { status: 429, headers: { 'content-type': 'application/json' } })

const authRejected = () => new Response(JSON.stringify({
  error: { data: { code: 401, msg: 'token invalid' } }
}), { status: 401, headers: { 'content-type': 'application/json' } })

// Out of credits on the first account: the second one answers, and the call succeeds.
{
  const result = await attempt({ 'token-primary': creditsExhausted, 'token-second': sse('第二个账号的回答') })
  assert.equal(result.failure, undefined, 'an exhausted balance is not the end of the request')
  assert.equal(result.text, '第二个账号的回答', 'the next account answered')
  assert.deepEqual(result.seen, ['token-primary', 'token-second'], 'accounts are tried in pool order')
  assert.equal(result.adapter.activeSlot().account, 'acc-b', 'the account that answered is remembered for display')
}

// A used-up rate window is the same story.
{
  const result = await attempt({ 'token-primary': rateWindow, 'token-second': sse('换个账号继续') })
  assert.equal(result.failure, undefined)
  assert.equal(result.text, '换个账号继续')
}

// Throttled: the gateway takes the model's queue position into the 429 body, and that is a
// "wait, or ask someone else" — not a verdict about the account.
{
  const result = await attempt({ 'token-primary': queued, 'token-second': sse('排队就换号') })
  assert.equal(result.failure, undefined, 'a queue is not the end of the request')
  assert.equal(result.text, '排队就换号')
  assert.equal([...new Set(result.seen)].join(','), 'token-primary,token-second')
}

// A dead credential: the account gets its one renewal and one resend first (that is the
// 401 path inside a single account), and only then does the request move on.
{
  const result = await attempt({ 'token-primary': authRejected, 'token-second': sse('凭据失效就换号') })
  assert.equal(result.failure, undefined, 'an expired credential on one account is not fatal')
  assert.equal(result.text, '凭据失效就换号')
  assert.equal([...new Set(result.seen)].join(','), 'token-primary,token-second', 'and both accounts were asked')
  assert.ok(result.seen.filter((token) => token === 'token-primary').length >= 2, 'the first account still got its renewal attempt and one resend before the switch')
}

// The order is the panel's order, not "whoever worked last": with the second account
// handling the request, the next call still starts from the first account.
{
  const result = await attempt({ 'token-primary': sse('第一个账号恢复后的回答'), 'token-second': sse('不该走到这里') })
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.seen, ['token-primary'], 'the pool order is not reordered by the previous answer')
}

// A delisted model is not: every account would refuse it identically, so the second one
// must not be tried at all.
{
  const result = await attempt({ 'token-primary': modelGone, 'token-second': sse('不该走到这里') })
  assert.ok(result.failure !== undefined, 'a delisted model still fails')
  assert.equal(result.failure.code, 'INVALID_REQUEST')
  assert.deepEqual(result.seen, ['token-primary'], 'the next account is not tried for a model everyone refuses')
}

// Every account out of credits: the user sees the real reason, not a generic failure.
{
  const result = await attempt({ 'token-primary': creditsExhausted, 'token-second': creditsExhausted })
  assert.ok(result.failure !== undefined)
  assert.equal(result.failure.code, 'QUOTA', 'the last refusal is reported')
  assert.match(result.failure.message, /积分已用尽/)
  assert.deepEqual(result.seen, ['token-primary', 'token-second'], 'both accounts were tried first')
}

// ---------------------------------------------------------------------------
// 4. Deployments never share accounts.
// ---------------------------------------------------------------------------

{
  const result = await attempt({ 'token-primary': sse('大陆版的回答') })
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.seen, ['token-primary'], 'a mainland request only ever uses mainland accounts')
  // The overseas pool is a different file and a different ref namespace.
  assert.equal(slotFor(intl, 'acc-b').tokenRef, `${intl.tokenRef}#acc-b`)
  assert.notEqual(slotFor(intl, 'acc-b').tokenRef, slotFor(cn, 'acc-b').tokenRef)
  assert.deepEqual(listAccounts(intl), [], 'signing into one deployment adds no account to the other')
}

// ---------------------------------------------------------------------------
// 5. A verdict written by a sweep is a verdict the panel can read.
// ---------------------------------------------------------------------------
//
// This is the bug this section exists for: the sweep keyed its ledger by the upstream
// uid while every reader asked for the pool account id, so the two never met and every
// model's dot stayed grey — with the whole suite green, because each half was tested on
// its own. The assertion below goes through a real sweep and reads the result back the
// way the panel does.

{
  const { runSweep } = await import('../../src/catalog/availability.js')
  const { aggregateAvailability } = await import('../../src/catalog/availability.js')

  setCredential(cn.tokenRef, 'token-primary')
  setCredential(cn.metaRef, JSON.stringify({ refreshToken: 'r', expiresAt: Date.now() + 3600_000, uid: 'u1', nickname: '主号', updatedAt: Date.now() }))

  // A probe that says "this model exists": the gateway rejected the empty request at the
  // parameter layer, which is the free answer the sweep relies on.
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { data: { code: 11133, msg: 'Invalid request parameters' } }
  }), { status: 400, headers: { 'content-type': 'application/json' } })

  const sweep = await runSweep({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined
  }, slotFor(cn, PRIMARY_ACCOUNT), ['hy3', 'glm-5.2'], { manual: true })
  assert.equal(sweep.skipped, false, 'a manual sweep runs')
  assert.equal(sweep.results.length, 2)

  const ids = listAccounts(cn).map((entry) => entry.id)
  const merged = aggregateAvailability(cn.id, ids).models
  assert.equal(merged.get('hy3')?.state, 'ok', 'the panel reads the verdict the sweep just wrote')
  assert.equal(merged.get('glm-5.2')?.state, 'ok')

  // And the key really is the pool account id — not the upstream uid it used to be.
  const { readAvailability } = await import('../../src/catalog/availability.js')
  assert.ok(readAvailability(cn.id, PRIMARY_ACCOUNT).models.has('hy3'), 'the primary account owns its ledger file')
  assert.ok(!readAvailability(cn.id, 'u1').models.has('hy3'), 'the upstream uid is not a ledger key')
}

console.log('pool.mjs: OK — primary account without migration, appended order, per-account refs, refs an older build wrote, one identity resolved to the id that holds its token, no row for an entry whose credentials are gone, fallback on quota/window/queue/dead credential, no fallback for a delisted model, order not reordered by the previous answer, pools isolated per deployment, and sweep verdicts readable by the panel')
