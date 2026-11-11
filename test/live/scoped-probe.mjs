/**
 * Dev probe: is the international scoped catalog endpoint broken for everyone,
 * or only for bearer-token callers? Compares unauthenticated / bad-token /
 * good-token responses on both deployments' scoped path.
 *
 * Run: `node test/live/scoped-probe.mjs`
 */

import { tokenOf } from './credentials.mjs'

const targets = [
  { name: 'INTL', endpoint: 'https://www.workbuddy.ai', domain: 'www.workbuddy.ai', token: tokenOf('WORKBUDDY_INTL_TOKEN') },
  { name: 'CN', endpoint: 'https://www.workbuddy.cn', domain: 'www.workbuddy.cn', token: tokenOf('WORKBUDDY_CN_TOKEN') }
]

for (const target of targets) {
  for (const variant of [
    { label: 'no auth', authorization: undefined },
    { label: 'bad token', authorization: 'Bearer not-a-real-token' },
    { label: 'real token', authorization: target.token.length > 0 ? `Bearer ${target.token}` : undefined }
  ]) {
    if (variant.authorization === undefined && variant.label === 'real token') continue
    try {
      const response = await fetch(`${target.endpoint}/console/enterprises/personal/models`, {
        headers: {
          Accept: 'application/json',
          'X-Domain': target.domain,
          'X-Product': 'SaaS',
          'X-Product-Code': 'workbuddy',
          'User-Agent': 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2',
          ...(variant.authorization === undefined ? {} : { Authorization: variant.authorization })
        },
        signal: AbortSignal.timeout(25_000)
      })
      const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 120)
      console.log(JSON.stringify({ target: target.name, variant: variant.label, status: response.status, body }))
    } catch (error) {
      console.log(JSON.stringify({ target: target.name, variant: variant.label, error: String(error).slice(0, 100) }))
    }
  }
}
