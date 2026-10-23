/**
 * Logging out hides the models, and the next login shows them again.
 *
 * The reported symptom: after signing out, the picker still listed the deployment's models
 * as usable — the cached catalog and the hand decisions were still there, so nothing said
 * "this deployment cannot be called".
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-logout-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { REGIONS } = await import('../../src/regions.js')
const { readPrefs, isEnabled, setEnabled, markLoggedOut, clearLoggedOut } = await import('../../src/model-prefs.js')
const { logoutRegion } = await import('../../src/auth.js')
const { setCredential, readCredential } = await import('../../src/paths.js')

const region = REGIONS.cn
const ctx = { logger: { info: () => {}, warn: () => {}, error: () => {} }, credentials: { resolve: async () => undefined } }

// A normal state: hy3 on by verdict, glm-5.2 hand-enabled.
setEnabled(region.id, ['glm-5.2'], true)
assert.equal(isEnabled(readPrefs(region.id), 'hy3', false), true, 'a working model is offered by its verdict')
assert.equal(isEnabled(readPrefs(region.id), 'glm-5.2', true), true, 'a hand decision wins over the verdict')

// After logout nothing is offered, whatever the verdicts and hand decisions say.
setCredential(region.tokenRef, 'access')
await logoutRegion(ctx, region)
assert.equal(readCredential(region.tokenRef), '', 'the token is gone')
assert.equal(isEnabled(readPrefs(region.id), 'hy3', false), false, 'a logged-out deployment offers nothing')
assert.equal(isEnabled(readPrefs(region.id), 'glm-5.2', true), false, 'and no cached hand decision can override that')
assert.ok(readPrefs(region.id).on.size === 0 && readPrefs(region.id).off.size === 0, 'logging out leaves no phantom hand decisions behind')

// A login clears the marker, and the verdict decides again.
clearLoggedOut(region.id)
assert.equal(isEnabled(readPrefs(region.id), 'hy3', false), true, 'after login a working model is offered again')
assert.equal(isEnabled(readPrefs(region.id), 'glm-5.2', true), false, 'and an unusable one is not, since its hand decision was cleared')

// Marking twice is harmless.
markLoggedOut(region.id)
assert.equal(markLoggedOut(region.id).alreadyOut, true)

console.log('logout.mjs: OK — logging out hides every model, and a login restores the verdict-based defaults')
