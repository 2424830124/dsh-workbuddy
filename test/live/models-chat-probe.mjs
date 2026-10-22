/**
 * Dev probe: send one minimal streaming request per China model over the
 * configured chat route, so a model-level policy ("service info not found",
 * queueing) can be told apart from an account- or channel-level failure.
 *
 * Run: `node test/models-chat-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { REGIONS, chatRoutes } from '../../src/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const token = (/^[ \t]*WORKBUDDY_CN_TOKEN:[ \t]*(.+)$/m.exec(readFileSync(credentialsPath, 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
if (token.length === 0) {
  console.log('no WORKBUDDY_CN_TOKEN')
  process.exit(1)
}

const region = REGIONS.cn
const [route] = chatRoutes(region)
const headers = {
  Authorization: `Bearer ${token}`,
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
  'X-Conversation-ID': crypto.randomUUID().replace(/-/g, ''),
  'X-Conversation-Message-ID': crypto.randomUUID(),
  'X-Conversation-Request-ID': crypto.randomUUID()
}
console.log('chat route:', route.endpoint)

const catalog = await fetch(`${region.endpoint}/console/enterprises/personal/models`, {
  headers: { ...headers, Accept: 'application/json', 'Content-Type': undefined }
}).then((response) => response.json()).catch(() => null)
const models = (catalog?.data?.models ?? []).map((model) => model.id).filter((id) => !id.startsWith('hunyuan-image'))
if (models.length === 0) {
  console.log('empty catalog')
  process.exit(1)
}

async function firstChunk(response) {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  try {
    while (result.length < 200) {
      const { value, done } = await reader.read()
      if (done) break
      result += decoder.decode(value, { stream: true })
    }
  } catch {}
  finally { reader.cancel().catch(() => {}) }
  return result.slice(0, 200)
}

const concurrency = 4
const results = []
let cursor = 0
async function worker() {
  while (cursor < models.length) {
    const model = models[cursor]
    cursor += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25_000)
    try {
      const response = await fetch(`${route.endpoint}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 8
        }),
        signal: controller.signal
      })
      const chunk = await firstChunk(response)
      const ok = response.status === 200 && chunk.includes('"choices"')
      results.push({ model, status: response.status, ok, detail: ok ? '' : chunk.replace(/\s+/g, ' ').slice(0, 160) })
    } catch (error) {
      results.push({ model, status: 0, ok: false, detail: String(error).slice(0, 120) })
    } finally {
      clearTimeout(timer)
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))
results.sort((a, b) => a.model.localeCompare(b.model))
for (const result of results) {
  console.log(JSON.stringify(result))
}
console.log('summary:', results.filter((r) => r.ok).length, 'ok /', results.length)
