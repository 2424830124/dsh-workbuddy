/**
 * Rebuild `test/.token` from the plugin's own credential document.
 *
 * `test/.token` holds a real login token and is therefore gitignored (see
 * AGENTS.md) — which also means it can be deleted by anything that cleans the
 * workspace, and the two manual probes that read it (`smoke.mjs`,
 * `credits-check.mjs`) then fail with ENOENT. This script regenerates it from
 * `$DSH_HOME/dsh-workbuddy/credentials.json`, which the panel login writes and
 * which is the only place those tokens are kept.
 *
 * Run: `node test/live/rebuild-token.mjs [cn|intl]`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const region = (process.argv[2] ?? 'cn').toLowerCase()
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const credentialsPath = join(home, 'dsh-workbuddy', 'credentials.json')

let credentials
try {
  credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'))
} catch (error) {
  console.error(`读不到 ${credentialsPath} — 请先在面板里登录（${error instanceof Error ? error.message : String(error)}）`)
  process.exit(1)
}

const tokenRef = region === 'cn' ? 'WORKBUDDY_CN_TOKEN' : 'WORKBUDDY_INTL_TOKEN'
const metaRef = region === 'cn' ? 'WORKBUDDY_CN_ACCOUNT' : 'WORKBUDDY_INTL_ACCOUNT'
const accessToken = typeof credentials[tokenRef] === 'string' ? credentials[tokenRef] : ''
if (accessToken.length === 0) {
  console.error(`${tokenRef} 为空 — 该部署还没有登录`)
  process.exit(1)
}

// The two probes read exactly these four fields, so only those are carried over.
// `expiresIn` is derived rather than copied: the metadata stores an absolute
// deadline, while the probes expect a duration in seconds.
let meta = {}
try {
  meta = JSON.parse(typeof credentials[metaRef] === 'string' ? credentials[metaRef] : '{}')
} catch {
  meta = {}
}
const expiresIn = typeof meta.expiresAt === 'number' ? Math.max(0, Math.floor((meta.expiresAt - Date.now()) / 1000)) : 0

const payload = {
  accessToken,
  refreshToken: typeof meta.refreshToken === 'string' ? meta.refreshToken : '',
  expiresIn,
  domain: typeof meta.domain === 'string' ? meta.domain : '',
  rebuiltAt: new Date().toISOString()
}

const target = new URL('../.token', import.meta.url)
writeFileSync(target, JSON.stringify(payload), 'utf8')
console.log(`已重建 test/.token（${region}，access token ${accessToken.length} 字符，expiresIn ${expiresIn}s）`)
