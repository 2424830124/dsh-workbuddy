/**
 * Dev probe: download every WorkBuddy web chunk and locate the code that
 * renders the picker's busy level / credits rate / thinking levels, to learn
 * which response field feeds each one.
 *
 * Run: `node test/live/web-bundle-probe.mjs all`
 *      `node test/live/web-search.mjs <regex>`
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'https://static.workbuddy.cn'
const PREFIX = '/web/agents/beebf62cf9c130b15160c5ed1be5d763eeeabd2e/assets/'
const CACHE = join(tmpdir(), 'wb-chunks')

const known = [
  'mac-dmg-prompt-services-D4rQvGgk.js', 'services-BgUCpH2g.js', 'services-CBfd2__f.js', 'services-CMs9PaX8.js',
  'services-CwPhYTCi.js', 'services-IcaX2kLm.js', 'services-l5n3YY1u.js', 'services-DQnPoPLv.js',
  'genie-chat-ui-CQYbyzbH.js', 'shared-i18n-EeHvzLJR.js', 'genie-monitor-B15nGeYg.js',
  'shared-account-http-DUBBMGAl.js', 'entry-shared-D4a4BgD6.js', 'main-ontenJGm.js', 'bridge-BgG4bpgK.js',
  'deeplink-C-63cQVz.js', 'zh-cn-BeHq-I_f.js', 'permission-preference-service-BnGjdkoI.js',
  'industry-config-provider-CKJkZigC.js', 'conversation-Cbw3wD6E.js', 'index-BYL27aBp.js', 'index-Ac_9FMzp.js',
  'index-8madUpd_.js', 'index-D07Rn5oY.js', 'skill-detail-modal-ByWM0cT5.js', 'standalone-skill-detail-modal-CIPpynVb.js'
]

mkdirSync(CACHE, { recursive: true })
let downloaded = 0
for (const file of known) {
  const target = join(CACHE, file)
  if (existsSync(target)) continue
  try {
    const response = await fetch(`${ROOT}${PREFIX}${file}`, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) {
      console.log(`skip ${file}: HTTP ${response.status}`)
      continue
    }
    const text = await response.text()
    writeFileSync(target, text)
    downloaded += 1
  } catch (error) {
    console.log(`skip ${file}: ${String(error).slice(0, 60)}`)
  }
}
const files = readdirSync(CACHE)
console.log(`downloaded ${downloaded}, cached ${files.length} chunks in ${CACHE}`)

// Locate the render sites: the i18n call for busy and the field feeding it.
const probes = [
  { name: 'busy call site', pattern: /.{220}model\.busy\.[^"'`]{0,20}[`"']?.{220}/g, skip: /":"/ },
  { name: 'busy field', pattern: /.{200}(?:busyLevel|modelBusy|busyStatus|isBusy|congestion)[\s\S]{0,160}/g },
  { name: 'effort call site', pattern: /.{200}model\.effort\.[^"'`]{0,20}[`"']?.{200}/g, skip: /":"/ },
  { name: 'effort field', pattern: /.{180}(?:supportedEfforts|effortLevel|reasoningEffort)[\s\S]{0,150}/g },
  { name: 'credits field', pattern: /.{180}(?:creditsRate|discountedCredits|credits)[\s\S]{0,120}/g }
]

for (const file of files) {
  const text = readFileSync(join(CACHE, file), 'utf8')
  for (const probe of probes) {
    let printed = 0
    for (const match of text.matchAll(probe.pattern)) {
      if (probe.skip !== undefined && probe.skip.test(match[0])) continue
      if (printed >= 3) break
      printed += 1
      console.log(`[${probe.name}] ${file} :: ${match[0].replace(/\s+/g, ' ').slice(0, 400)}`)
    }
  }
}
