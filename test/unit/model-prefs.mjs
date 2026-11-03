/**
 * Unit check for the per-model switches.
 *
 * The rule is now "nothing is offered until the user asks for it": the verdict no longer
 * decides a default, so a fresh login cannot leave a rate-limited model switched on and
 * waiting to be turned off by hand.
 *
 * Run: `node test/unit/model-prefs.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-prefs-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { isEnabled, readPrefs, setEnabled, markLoggedOut, clearLoggedOut } = await import('../../src/catalog/model-prefs.js')
const { probeBody } = await import('../../src/catalog/availability.js')
const { REGIONS } = await import('../../src/core/regions.js')

// Nothing chosen yet: every model is off, whatever the verdict says.
const fresh = readPrefs('cn')
assert.equal(isEnabled(fresh, 'hy3'), false, 'a usable model is off until the user enables it')
assert.equal(isEnabled(fresh, 'glm-4.6'), false, 'and so is an unusable one')
assert.equal(fresh.enabled.size, 0, 'the file records only what was turned on')

// Turning one on records exactly that id.
setEnabled('cn', ['glm-4.6'], true)
const decided = readPrefs('cn')
assert.equal(isEnabled(decided, 'glm-4.6'), true, 'an enabled model is offered')
assert.equal(isEnabled(decided, 'hy3'), false, 'the others stay off')
assert.deepEqual([...decided.enabled], ['glm-4.6'], 'only the chosen id is stored')

// Bulk turns a whole list on (that is what 全部启用 does).
setEnabled('cn', ['hy3', 'glm-4.6', 'kimi-k3'], true)
const allOn = readPrefs('cn')
assert.equal(isEnabled(allOn, 'hy3'), true)
assert.equal(isEnabled(allOn, 'glm-4.6'), true)
assert.equal(isEnabled(allOn, 'kimi-k3'), true)

// Turning one off removes it from the set rather than recording a negative.
setEnabled('cn', ['hy3'], false)
const oneOff = readPrefs('cn')
assert.equal(isEnabled(oneOff, 'hy3'), false)
assert.deepEqual([...oneOff.enabled].sort(), ['glm-4.6', 'kimi-k3'], 'the disabled id is simply gone')

// Resetting clears the set: everything off again, which is the default.
setEnabled('cn', ['hy3', 'glm-4.6', 'kimi-k3'], true, { reset: true })
const reset = readPrefs('cn')
assert.equal(isEnabled(reset, 'glm-4.6'), false, 'back to the default')
assert.equal(reset.enabled.size, 0)

// Deployments keep separate switches.
setEnabled('intl', ['gpt-5.6-sol'], true)
assert.deepEqual([...readPrefs('intl').enabled], ['gpt-5.6-sol'])
assert.equal(readPrefs('cn').enabled.size, 0, 'the China list is untouched')

// Logging out hides everything but must not forget the set: the account may come back, and
// re-picking the switches by hand is exactly the chore this file exists to avoid.
setEnabled('cn', ['hy3'], true)
markLoggedOut('cn')
assert.equal(isEnabled(readPrefs('cn'), 'hy3'), false, 'a logged-out region offers nothing')
assert.deepEqual([...readPrefs('cn').enabled], ['hy3'], 'but the choice survives the logout')
clearLoggedOut('cn')
assert.equal(isEnabled(readPrefs('cn'), 'hy3'), true, 'and comes back with the next login')

// A v1 file (on/off) is migrated: its `on` list was the user's deliberate choice, its `off`
// list only disagreed with a default that no longer exists.
{
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const dir = join(process.env.DSH_HOME, 'dsh-workbuddy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'enabled-intl.json'), JSON.stringify({ version: 1, on: ['legacy-on'], off: ['legacy-off'] }))
  const migrated = readPrefs('intl')
  assert.equal(isEnabled(migrated, 'legacy-on'), true, 'the v1 enabled list carries over')
  assert.equal(isEnabled(migrated, 'legacy-off'), false, 'and the old off list is dropped, which is now the default anyway')
}

// The probe shape follows the deployment: free where the gateway resolves the
// model first, a one-token completion where it validates the conversation first.
const cnBody = probeBody(REGIONS.cn, 'hy3')
assert.deepEqual(cnBody.messages, [], 'China probes with an empty conversation, which never generates')
assert.equal(cnBody.max_tokens, undefined)
const intlBody = probeBody(REGIONS.intl, 'hy3')
assert.equal(intlBody.messages[0].role, 'system', 'international needs a system-first conversation')
assert.equal(intlBody.max_tokens, 1, 'international probes ask for a single token')

console.log('model-prefs.mjs: OK — off by default, the recorded set, bulk toggles, logout survival, v1 migration, and per-deployment probe shapes verified')
