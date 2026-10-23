/**
 * Binary-search the DSH system prompt for the sentence the China gateway now treats
 * as an "unapproved channel".
 *
 * Each probe sends half of the remaining paragraphs; whichever half is still rejected
 * contains the fingerprint. Cheap: a 50-paragraph prompt needs ~6 requests.
 *
 * Run: `node test/live/cn-prompt-fingerprint.mjs [model]`
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

// --- the newest harness prompt ---
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
console.log(`提示词 ${system.length} 字符，${paragraphs.length} 段\n`)

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

/** true when the gateway accepts this prompt text. */
const accepted = async (text) => {
  try {
    for await (const chunk of adapter.stream({
      provider: region.provider,
      model,
      system: text,
      messages: [{ role: 'user', content: [{ type: 'text', text: '说"好"。' }] }],
      maxTokens: 16,
      signal: AbortSignal.timeout(120_000)
    })) void chunk
    return true
  } catch (error) {
    if (String(error.code) === 'INVALID_REQUEST' && /unapproved channel/i.test(String(error.message))) return false
    return true // a different failure is not the fingerprint
  }
}

// Always keep the first paragraph's shape (it is sanitized) so the rest is comparable.
const probe = async (subset) => accepted(subset.join('\n\n') + '\n\n' + '说"好"。')

let low = 0
let high = paragraphs.length - 1
console.log(`整段是否被拒: ${(await probe(paragraphs)) ? '通过' : '被拒 ✓（说明指纹在提示词里）'}`)

// Binary search on "which paragraph, if removed, unblocks it".
let culprit
while (low < high) {
  const mid = Math.floor((low + high) / 2)
  const withoutSecondHalf = paragraphs.slice(0, mid + 1)
  const ok = await probe(withoutSecondHalf)
  console.log(`  试：只保留前 ${mid + 1} 段（共 ${paragraphs.length}）→ ${ok ? '通过 ✓' : '被拒 ✗'}`)
  if (ok) {
    // the fingerprint lives in the dropped part
    low = mid + 1
  } else {
    high = mid
  }
}
culprit = paragraphs[low]
console.log(`\n🎯 可疑段落（第 ${low + 1} 段，${culprit.length} 字符）：`)
console.log('---')
console.log(culprit.slice(0, 600))
console.log('---')

const withoutCulprit = paragraphs.filter((_, index) => index !== low)
console.log(`去掉该段后: ${(await probe(withoutCulprit)) ? '通过 ✓（确认就是它）' : '仍被拒 ✗（可能不止一处）'}`)
