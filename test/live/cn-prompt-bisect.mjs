/**
 * Dev probe: which part of the DSH system prompt makes the China gateway answer
 * "Illegal API invocation from an unapproved channel"?
 *
 * The sanitizer only rewrites the opening line. This sends the real prompt from a
 * session, then progressively removes candidate fingerprints, and reports which
 * variant the gateway accepts.
 *
 * Run: `node test/live/cn-prompt-bisect.mjs`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const region = REGIONS.cn
const model = process.argv[2] ?? 'deepseek-v4.1-flash'

// --- collect the newest harness system prompt ---
const root = join(home, 'sessions')
const candidates = []
for (const project of readdirSync(root)) {
  const projectDir = join(root, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  for (const name of names) {
    const dir = join(projectDir, name)
    let files
    try { files = readdirSync(dir).filter((entry) => entry.endsWith('.zstd')) } catch { continue }
    for (const file of files) candidates.push(dir + '|' + file)
  }
}
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let system
for (const candidate of candidates.slice(-12)) {
  const [dir, file] = candidate.split('|')
  const buffer = readFileSync(join(dir, file))
  const parts = []
  let at = buffer.indexOf(magic)
  while (at >= 0) {
    try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn */ }
    at = buffer.indexOf(magic, at + 4)
  }
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line.includes('system/message')) continue
    try {
      const event = JSON.parse(line)
      const message = event.data?.message
      const text = Array.isArray(message?.content) ? message.content.map((block) => String(block?.text ?? '')).join('') : ''
      if (text.includes('DeepSeek Harness')) system = text
    } catch { /* torn */ }
  }
  if (system !== undefined) break
}
if (system === undefined) { console.log('没找到 DSH 系统提示词'); process.exit(1) }
console.log(`系统提示词 ${system.length} 字符\n`)

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \t]*${ref}:[ \t]*(.+)$`, 'm').exec(readFileSync(`${home}/.credentials.yaml`, 'utf8'))
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  },
  get: () => undefined
}
const token = await readToken(ctx, region)
if (token === undefined || token.length === 0) { console.log('没有大陆版令牌'); process.exit(0) }
const adapter = new WorkBuddyAdapter(ctx, region)
adapter.catalog = []
adapter.catalogAt = Date.now()

// `sanitizeSystem` is applied inside buildBody, so each variant is the *input*.
const variants = [
  { label: '原样完整提示词（只靠现有清洗）', text: system },
  { label: '去掉 "Tokens prefixed with @ …" 那一句', text: system.replace(/Tokens prefixed with @[^\n]*\n?/g, '') },
  { label: '去掉第 2 段（"You are a coding agent powered by … model."）', text: system.replace(/\n*You are a coding agent powered by [^\n]*\n?/g, '\n') },
  { label: '只留第一句（最短对照）', text: 'You are an AI agent powered by DeepSeek Harness.' },
  { label: '整段替换为中性提示词', text: 'You are a helpful assistant.' }
]

for (const variant of variants) {
  let outcome
  try {
    let finish
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system: variant.text,
      messages: [{ role: 'user', content: [{ type: 'text', text: '说"好"。' }] }],
      maxTokens: 32,
      signal: AbortSignal.timeout(120_000)
    })) {
      if (chunk.type === 'finish') finish = chunk.reason
    }
    outcome = `✅ 成功（finish=${finish?.kind ?? '?'}）`
  } catch (error) {
    outcome = `❌ ${error.code ?? ''} ${String(error.message).slice(0, 80)}`
  }
  console.log(`${variant.label}\n  → ${outcome}`)
}
