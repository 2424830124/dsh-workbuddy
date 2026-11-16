/**
 * Unit check: the client's placeholder order, the Host's display order, and the
 * default tab must agree — a mismatch made the tabs swap places the instant the
 * first `/state` answer arrived.
 *
 * Run: `node test/unit/region-order.mjs`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../../client/index.js', import.meta.url), 'utf8')
const { REGION_IDS } = await import('../../src/core/regions.js')

const placeholderBlock = /const PLACEHOLDER_REGIONS = \[([\s\S]*?)\n {4}\]/.exec(client)
assert.ok(placeholderBlock !== null, 'the placeholder list is present')
const placeholderIds = [...placeholderBlock[1].matchAll(/id: '([a-z]+)'/g)].map((match) => match[1])

assert.deepEqual(placeholderIds, REGION_IDS, 'the placeholder tabs are in the Host display order')

const defaultTab = /const \[activeId, setActiveId\] = React\.useState\('([a-z]+)'\)/.exec(client)
assert.ok(defaultTab !== null, 'the initial tab is set')
assert.equal(defaultTab[1], REGION_IDS[0], 'the panel opens on the first deployment in display order')

// `defaultTab()` follows the same rule: first signed-in, else the first listed.
assert.match(client, /function defaultTab\(regions\) \{[\s\S]*?regions\.find\(\(region\) => region\.loggedIn \|\| region\.pending\)[\s\S]*?\}/,
  'defaultTab prefers the first signed-in deployment')

console.log(`region-order.mjs: OK — display order ${REGION_IDS.join(', ')} matches the placeholders and the default tab`)
