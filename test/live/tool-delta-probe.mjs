/**
 * Dev probe: does the gateway ever stream a tool_calls fragment without a name?
 *
 * The plugin now turns such a call into a retryable error, so this measures whether
 * the situation actually happens: it reads the raw SSE itself (no adapter parsing) and
 * reports, per run, whether every tool call carried a function name and how the
 * stream ended.
 *
 * Overseas free deepseek-v4.1-flash only.
 * Run: `node test/live/tool-delta-probe.mjs [rounds] [fillerChars]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const rounds = Number(process.argv[2] ?? 6)
const fillerChars = Number(process.argv[3] ?? 90_000)
const region = REGIONS.intl
const model = 'deepseek-v4.1-flash'

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(`${home}/.credentials.yaml`, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}
const token = await readToken(ctx, region)
if (token === undefined || token.length === 0) { console.log('没有海外版令牌'); process.exit(0) }

const tools = [{
  type: 'function',
  function: {
    name: 'write',
    description: 'Write a file.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content']
    }
  }
}, {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  }
}]

const filler = (chars) => {
  const messages = []
  let produced = 0
  let index = 0
  while (produced < chars) {
    const step = `第 ${index + 1} 步：读取 src/module${index}.js，把其中的 TODO 注释替换为实现说明，然后运行单测确认通过。`
    messages.push({ role: 'user', content: step })
    messages.push({ role: 'assistant', content: `已处理 src/module${index}.js：替换了 ${index % 7 + 1} 处 TODO，单测通过。` })
    produced += step.length + 40
    index += 1
  }
  return messages
}
const messages = [...filler(fillerChars), {
  role: 'user',
  content: '现在把 E:\\Projects\\demo\\src\\index.js 里的 console.log("a") 改成 console.log("b")。'
}]

for (let round = 1; round <= rounds; round += 1) {
  const response = await fetch(`${region.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-domain': region.apiDomain,
      'x-product': 'SaaS',
      'x-product-code': 'workbuddy',
      'user-agent': region.userAgent
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1024,
      reasoning_effort: 'high'
    })
  })
  if (!response.ok) { console.log(`${round}. HTTP ${response.status} — ${(await response.text()).slice(0, 120)}`); continue }

  let buffer = ''
  let finishReason
  let sawDone = false
  const calls = new Map()
  let text = ''
  for await (const chunk of response.body) {
    buffer += new TextDecoder().decode(chunk, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { sawDone = true; break }
      let data
      try { data = JSON.parse(payload) } catch { continue }
      const choice = data.choices?.[0]
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) finishReason = choice.finish_reason
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0
        const entry = calls.get(index) ?? { name: undefined, fragments: 0, id: undefined }
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) entry.name = call.function.name
        if (typeof call.id === 'string' && call.id.length > 0) entry.id = call.id
        entry.fragments += 1
        calls.set(index, entry)
      }
    }
    if (sawDone) break
  }

  const nameless = [...calls.values()].filter((entry) => entry.name === undefined)
  const summary = [...calls.entries()].map(([index, entry]) => `#${index}:${entry.name ?? '无名'}`).join(' ') || '（无工具调用）'
  console.log(`${round}. finish=${finishReason ?? '(无)'} [DONE]=${sawDone} 工具调用分片 ${summary} 正文 ${text.length} 字${nameless.length > 0 ? '  ⚠ 有无名调用' : ''}`)
  if (text.trim().length > 0) console.log(`   正文：「${text.trim().slice(0, 50)}」`)
}
