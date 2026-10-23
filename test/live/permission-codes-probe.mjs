/**
 * Dev probe: what the two deployments answer for "blocked" and "not allowed"
 * situations, so the panel's state labels can be tied to real codes.
 *
 * - a tampered bearer token (auth failure)
 * - a model the deployment lists but this account is not entitled to (intl)
 * - a model the account is entitled to (control)
 * - the console-only routes with a plugin token (permission fence)
 *
 * Run: `node test/live/permission-codes-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { REGIONS } from '../../src/core/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const text = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(text)
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}
const cnToken = tokenOf('WORKBUDDY_CN_TOKEN')
const intlToken = tokenOf('WORKBUDDY_INTL_TOKEN')
const tampered = `${intlToken.slice(0, -4)}AAAA`

async function chat(region, token, model, body = {}) {
  const response = await fetch(`${region.chatEndpoint ?? region.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Domain': region.chatApiDomain ?? region.apiDomain,
      'X-Product': 'SaaS',
      'X-Product-Code': 'workbuddy',
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Version': region.version,
      'User-Agent': region.userAgent,
      'X-Conversation-ID': crypto.randomUUID().replace(/-/g, '')
    },
    body: JSON.stringify({ model, messages: [], stream: true, ...body }),
    signal: AbortSignal.timeout(25_000)
  })
  const body2 = await response.text()
  return {
    status: response.status,
    code: /"code":(\d+)/.exec(body2)?.[1] ?? (/"(?:error|error_msg)"/.test(body2) ? (/"(?:error|error_msg)":"([^"]{0,40})/.exec(body2)?.[1] ?? '-') : '-'),
    msg: (/"(?:msg|error_description|error_msg)":"([^"]{0,60})/.exec(body2)?.[1] ?? body2.replace(/\s+/g, ' ').slice(0, 60))
  }
}

const rows = [
  { label: 'INTL 篡改令牌', run: () => chat(REGIONS.intl, tampered, 'hy3') },
  { label: 'INTL 空令牌', run: () => chat(REGIONS.intl, '', 'hy3') },
  { label: 'INTL 未授权模型 gpt-6-astra', run: () => chat(REGIONS.intl, intlToken, 'gpt-6-astra') },
  { label: 'INTL 已授权模型 gpt-5.6-sol', run: () => chat(REGIONS.intl, intlToken, 'gpt-5.6-sol') },
  { label: 'INTL 目录外模型 gpt-9-nope', run: () => chat(REGIONS.intl, intlToken, 'gpt-9-nope') },
  { label: 'CN 篡改令牌', run: () => chat(REGIONS.cn, `${cnToken.slice(0, -4)}AAAA`, 'hy3') }
]

for (const row of rows) {
  try {
    const result = await row.run()
    console.log(`${row.label.padEnd(34)} HTTP ${result.status}  code=${result.code}  ${result.msg}`)
  } catch (error) {
    console.log(`${row.label.padEnd(34)} ERR ${String(error).slice(0, 60)}`)
  }
}

// Console-only routes, which is where a real permission fence shows up.
for (const [label, url, token] of [
  ['INTL scoped (token)', `${REGIONS.intl.endpoint}/console/enterprises/personal/models`, intlToken],
  ['INTL private-configs', `${REGIONS.intl.endpoint}/console/as/users/private-configs/query`, intlToken],
  ['CN /v3/config (token)', `${REGIONS.cn.endpoint}/v3/config`, cnToken]
]) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-Domain': 'www.workbuddy.ai', 'User-Agent': REGIONS.intl.userAgent },
    signal: AbortSignal.timeout(20_000)
  })
  const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 90)
  console.log(`${label.padEnd(34)} HTTP ${response.status}  ${body}`)
}
