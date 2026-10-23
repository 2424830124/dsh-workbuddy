/**
 * Sentence-level bisect inside the paragraph the China gateway rejects.
 *
 * The paragraph is loaded from the newest session prompt (index from argv) and split
 * into sentences; each probe sends the surviving sentences, so whichever sentence, when
 * present, causes the rejection is the fingerprint.
 *
 * Run: `node test/live/cn-fingerprint-sentence.mjs [paragraphIndex] [model]`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { readToken } from '../../src/auth.js'
import { REGIONS } from '../../src/regions.js'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const paragraphIndex = Number(process.argv[2] ?? 17)
const region = REGIONS.cn
const model = process.argv[3] ?? 'deepseek-v4.1-flash'

const root = join(home, 'sessions')
const logs = []
for (const project of readdirSync(root)) {
  const projectDir = join(root, project)
  let names
  try { names = readdirSync(projectDir) } catch { continue }
  for (const name of names) {
    const dir = join(projectDir, name)
    let files
    try { files = readdirSync(dir).filter((entry) => entry.endsWith('.zstd')) } catch { continue }
    for (const file of files) logs.push(join(dir, file))
  }
}
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
let system
for (const file of logs.slice(-12)) {
  const buffer = readFileSync(file)
  const parts = []
  let at = buffer.indexOf(magic)
  while (at >= 0) {
    try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn */ }
    at = buffer.indexOf(magic, at + 4)
  }
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line.includes('system/message')) continue
    try {
      const message = JSON.parse(line).data?.message
      const text = Array.isArray(message?.content) ? message.content.map((block) => String(block?.text ?? '')).join('') : ''
      if (text.includes('DeepSeek Harness')) system = text
    } catch { /* torn */ }
  }
  if (system !== undefined) break
}
if (system === undefined) { console.log('没找到 DSH 系统提示词'); process.exit(1) }

const paragraphs = system.split(/\n{2,}/).filter((part) => part.trim().length > 0)
const target = paragraphs[paragraphIndex]
if (target === undefined) { console.log(`没有第 ${paragraphIndex} 段（共 ${paragraphs.length}）`); process.exit(1) }
const sentences = target.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0)
console.log(`第 ${paragraphIndex} 段：${target.length} 字符，${sentences.length} 句\n`)

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

const accepted = async (parts) => {
  try {
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system: `You are a helpful assistant.\n\n${parts.join(' ')}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: '说"好"。' }] }],
      maxTokens: 16,
      signal: AbortSignal.timeout(120_000)
    })) void chunk
    return true
  } catch (error) {
    return !/unapproved channel/i.test(String(error.message))
  }
}

console.log(`整段 → ${(await accepted([target])) ? '通过' : '被拒 ✓'}`)
for (let index = 0; index < sentences.length; index += 1) {
  const ok = await accepted([sentences[index]])
  console.log(`  [${index}] ${ok ? '✅ 通过' : '❌ 被拒'}  ${sentences[index].slice(0, 110)}`)
}
