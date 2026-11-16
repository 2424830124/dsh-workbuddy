/** End-to-end check: does the patched adapter get a real CN answer? */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { REGIONS } from '../../src/core/regions.js'

const root = join(process.env.DSH_HOME, 'sessions')
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const files = []
for (const project of readdirSync(root)) {
  const pd = join(root, project)
  let names
  try { names = readdirSync(pd) } catch { continue }
  for (const name of names) {
    const dir = join(pd, name)
    let inner
    try { inner = readdirSync(dir).filter((e) => e.endsWith('.zstd')) } catch { continue }
    for (const f of inner) files.push({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs })
  }
}
files.sort((a, b) => b.at - a.at)
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((b) => String(b?.text ?? '')).join('') : String(m?.content ?? ''))

let system
let tools
for (const f of files.slice(0, 10)) {
  const buf = readFileSync(f.path)
  const parts = []
  let at = buf.indexOf(magic)
  while (at >= 0) { try { parts.push(zstdDecompressSync(buf.subarray(at))) } catch {} at = buf.indexOf(magic, at + 4) }
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  const hdr = events.filter((e) => e.type === 'request/header').at(-1)
  if (hdr?.data?.header?.config?.provider !== '@huai_xin/dsh-workbuddy/cn') continue
  system = events.filter((e) => e.type === 'system/message').map((e) => textOf(e.data?.message)).at(-1)
  tools = hdr.data.header.tools
  break
}
if (!system) { console.log('no cn system prompt found'); process.exit(1) }

const ctx = { logger: { info() {}, warn() {}, error() {} }, get() {}, credentials: { resolve: async () => undefined } }
const adapter = new WorkBuddyAdapter(ctx, REGIONS.cn)
adapter.catalog = []
adapter.catalogAt = Date.now()

// The unmodified harness prompt — exactly what the plugin receives in production.
console.log('system', system.length, 'chars | tools', tools?.length)
let text = ''
let fin
try {
  for await (const c of adapter.stream({
    provider: REGIONS.cn.provider,
    model: 'hy3',
    system,
    tools,
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
    maxTokens: 64,
    signal: AbortSignal.timeout(180000)
  })) {
    if (c.type === 'text-delta') text += c.text ?? ''
    if (c.type === 'finish') fin = c
  }
  console.log('PASS — reply:', JSON.stringify(text.slice(0, 60)), '| stop:', fin?.reason?.kind)
} catch (e) {
  console.log('FAIL —', e.code, String(e.message).slice(0, 100))
  process.exit(1)
}
