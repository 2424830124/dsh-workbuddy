/**
 * Logging out hides the models, and the next login brings the user's choices back.
 *
 * Two symptoms are pinned here:
 *
 * 1. After signing out the picker still listed the deployment's models as usable — the cached
 *    catalog said nothing about "this deployment cannot be called".
 * 2. Logging out used to wipe the switch state, so signing back in left every model off and the
 *    user re-picking them by hand. The set now survives: it describes what the user chose, not
 *    what the credentials currently allow.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-logout-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { REGIONS } = await import('../../src/core/regions.js')
const { readPrefs, isEnabled, setEnabled, markLoggedOut, clearLoggedOut } = await import('../../src/catalog/model-prefs.js')
const { logoutRegion } = await import('../../src/account/auth.js')
const { listAccounts, registerAccount, slotFor } = await import('../../src/account/pool.js')
const { setCredential, readCredential } = await import('../../src/core/paths.js')

const region = REGIONS.cn
const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} }, credentials: { resolve: async () => undefined } }

// A normal state: the user turned two models on, and nothing else is offered.
setEnabled(region.id, ['glm-5.2', 'hy3'], true)
assert.equal(isEnabled(readPrefs(region.id), 'hy3'), true, 'an enabled model is offered')
assert.equal(isEnabled(readPrefs(region.id), 'glm-5.2'), true)
assert.equal(isEnabled(readPrefs(region.id), 'kimi-k3'), false, 'and nothing else is')

// After logout nothing is offered, whatever the recorded set says.
setCredential(region.tokenRef, 'access')
await logoutRegion(ctx, region)
assert.equal(readCredential(region.tokenRef), '', 'the token is gone')
assert.equal(isEnabled(readPrefs(region.id), 'hy3'), false, 'a logged-out deployment offers nothing')
assert.equal(isEnabled(readPrefs(region.id), 'glm-5.2'), false)
assert.deepEqual([...readPrefs(region.id).enabled].sort(), ['glm-5.2', 'hy3'], 'but logging out does not forget the choices')

// A login clears the marker, and the recorded choices are offered again.
clearLoggedOut(region.id)
assert.equal(isEnabled(readPrefs(region.id), 'hy3'), true, 'after login the choices come back')
assert.equal(isEnabled(readPrefs(region.id), 'glm-5.2'), true)
assert.equal(isEnabled(readPrefs(region.id), 'kimi-k3'), false, 'and the models nobody enabled stay off')

// Marking twice is harmless.
markLoggedOut(region.id)
assert.equal(markLoggedOut(region.id).alreadyOut, true)
assert.deepEqual([...readPrefs(region.id).enabled].sort(), ['glm-5.2', 'hy3'], 'and still does not touch the set')

// Signing out must also take the account's *identity* with it, not just its token. This is the
// row that survived its own logout on a real install: the pool file indexed the bare upstream
// uid while the credentials were written under `<login time>#<uid>`, and deleting the
// credentials before identifying the account left a pool entry with nothing pointing at it —
// the panel drew it as 未知 / 未登录 and no click could get rid of it.
const orphanId = '100000002'
const holderId = `1700001200000#${orphanId}`
registerAccount(region, { id: orphanId, nickname: '示例小号', uid: orphanId })
setCredential(`${region.tokenRef}#${holderId}`, 'holder.access')
setCredential(`${region.metaRef}#${holderId}`, JSON.stringify({ nickname: '示例小号', uid: orphanId, updatedAt: Date.now() }))
assert.deepEqual(listAccounts(region).map((entry) => entry.id), [holderId], 'the id holding the token is the account')

await logoutRegion(ctx, slotFor(region, holderId))
assert.equal(readCredential(`${region.tokenRef}#${holderId}`), '', 'its token is deleted')
assert.deepEqual(listAccounts(region), [], 'and no id of that identity is left to draw a row from')

console.log('logout.mjs: OK — logging out hides every model while the enabled set survives, a login offers them again, and signing one account out leaves no row of it behind')
