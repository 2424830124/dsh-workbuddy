/**
 * Dev probe: what does a China availability probe actually send? Prints the
 * resolved route, the token reference it used, the exact body, and the answer —
 * so the free shape (`messages: []`) can be confirmed rather than assumed.
 *
 * Run: `node test/live/cn-probe-shape-check.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { probeBody } from '../../src/catalog/availability.js'
import { chatRoutes, REGIONS } from '../../src/core/regions.js'

const region = REGIONS.cn
const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const yaml = readFileSync(credentialsPath, 'utf8')
const tokenOf = (name) => {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm').exec(yaml)
  return match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '')
}

const [route] = chatRoutes(region)
const body = probeBody(region, 'hy3')
console.log('部署:', region.id, '| freeProbe =', region.freeProbe)
console.log('路由:', route.endpoint, '| apiDomain:', route.apiDomain)
console.log('令牌引用:', region.tokenRef, '| 取到:', tokenOf(region.tokenRef).length, '字符')
console.log('另外一个部署的令牌长度:', tokenOf('WORKBUDDY_INTL_TOKEN').length, '字符')
console.log('请求体:', JSON.stringify(body))

const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokenOf(region.tokenRef)}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Domain': route.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': route.productCode,
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': route.ideName,
    'X-IDE-Type': route.ideName,
    'X-IDE-Version': route.ideVersion,
    'User-Agent': route.userAgent,
    'X-Conversation-ID': crypto.randomUUID().replace(/-/g, '')
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(30_000)
})
const text = await response.text()
const generated = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].reduce((sum, match) => sum + match[1].length, 0)
console.log(`响应: HTTP ${response.status} code=${/"code":(\d+)/.exec(text)?.[1] ?? '-'} ${generated > 0 ? `⚠ 生成了 ${generated} 字` : '未生成 ✓'}`)
console.log('  ', text.replace(/\s+/g, ' ').slice(0, 120))
