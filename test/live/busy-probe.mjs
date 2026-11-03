/**
 * Dev probe: the web picker's "繁忙程度" comes from `POST /v2/chat/busy`
 * ({models:[id,…]} → {data:[{model,busy_level}]}). Check whether a plugin
 * bearer token can call it on both deployments, and what values come back.
 *
 * Run: `node test/live/busy-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const text = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(text)
  return match === null ? '' : match[1].trim().replace(/^['"]|['"]$/g, '')
}

const models = ['hy3', 'deepseek-v4.1-flash', 'glm-5.3', 'auto', 'step-5-preview']
const targets = [
  { id: 'cn', endpoint: 'https://www.workbuddy.cn', domain: 'www.workbuddy.cn', token: tokenOf('WORKBUDDY_CN_TOKEN'), ua: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2' },
  { id: 'intl', endpoint: 'https://www.workbuddy.ai', domain: 'www.workbuddy.ai', token: tokenOf('WORKBUDDY_INTL_TOKEN'), ua: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2' }
]

for (const target of targets) {
  for (const [label, headers] of [
    ['bearer', {
      Authorization: `Bearer ${target.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Domain': target.domain,
      'X-Product': 'SaaS',
      'X-Product-Code': 'workbuddy',
      'User-Agent': target.ua
    }]
  ]) {
    try {
      const response = await fetch(`${target.endpoint}/v2/chat/busy`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ models }),
        signal: AbortSignal.timeout(20_000)
      })
      const body = (await response.text()).replace(/\s+/g, ' ')
      console.log(JSON.stringify({ target: target.id, auth: label, status: response.status, body: body.slice(0, 500) }))
    } catch (error) {
      console.log(JSON.stringify({ target: target.id, auth: label, error: String(error).slice(0, 120) }))
    }
  }
}

// Control: the browser holds a China console cookie session; ask it too so the
// two auth modes can be compared in one run.
console.log('--- with the browser session (if the page is open) ---')
