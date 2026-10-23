/**
 * Unit check for the per-model switches: the verdict sets the default, a hand
 * decision always wins, and only the decisions are stored.
 *
 * Run: `node test/unit/model-prefs.mjs`
 */

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'dsh-workbuddy-prefs-test')
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const { isEnabled, readPrefs, setEnabled } = await import('../../src/catalog/model-prefs.js')
const { probeBody } = await import('../../src/catalog/availability.js')
const { REGIONS } = await import('../../src/core/regions.js')

// Nothing decided yet: a usable model is on, an unusable one is off.
const fresh = readPrefs('cn')
assert.equal(isEnabled(fresh, 'hy3', false), true, 'a usable model defaults to on')
assert.equal(isEnabled(fresh, 'glm-4.6', true), false, 'an unusable model defaults to off')

// A hand decision beats the verdict in both directions.
setEnabled('cn', ['glm-4.6'], true)
setEnabled('cn', ['hy3'], false)
const decided = readPrefs('cn')
assert.equal(isEnabled(decided, 'glm-4.6', true), true, 'an unusable model can be turned on by hand')
assert.equal(isEnabled(decided, 'hy3', false), false, 'a usable model can be turned off by hand')

// Bulk turns a whole list one way (that is what 一键启停 and the group button do).
setEnabled('cn', ['hy3', 'glm-4.6', 'kimi-k3'], true)
const allOn = readPrefs('cn')
assert.equal(isEnabled(allOn, 'hy3', false), true)
assert.equal(isEnabled(allOn, 'glm-4.6', true), true)
assert.equal(isEnabled(allOn, 'kimi-k3', false), true)

// Resetting forgets the decision, so the verdict decides again.
setEnabled('cn', ['hy3', 'glm-4.6', 'kimi-k3'], true, { reset: true })
const reset = readPrefs('cn')
assert.equal(isEnabled(reset, 'hy3', false), true)
assert.equal(isEnabled(reset, 'glm-4.6', true), false, 'back to the verdict default')
assert.equal(reset.on.size, 0)
assert.equal(reset.off.size, 0)

// Deployments keep separate switches.
setEnabled('intl', ['gpt-5.6-sol'], false)
assert.equal(readPrefs('intl').off.size, 1)
assert.equal(readPrefs('cn').off.size, 0, 'the China list is untouched')

// The probe shape follows the deployment: free where the gateway resolves the
// model first, a one-token completion where it validates the conversation first.
const cnBody = probeBody(REGIONS.cn, 'hy3')
assert.deepEqual(cnBody.messages, [], 'China probes with an empty conversation, which never generates')
assert.equal(cnBody.max_tokens, undefined)
const intlBody = probeBody(REGIONS.intl, 'hy3')
assert.equal(intlBody.messages[0].role, 'system', 'international needs a system-first conversation')
assert.equal(intlBody.max_tokens, 1, 'international probes ask for a single token')

console.log('model-prefs.mjs: OK — verdict defaults, hand overrides, bulk toggles, reset, and per-deployment probe shapes verified')
