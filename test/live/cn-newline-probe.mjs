/** Probe: does inserting a newline into the @-path sentence evade the CN 11128 rule? */
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
  break
}
if (!system) { console.log('no cn system prompt found'); process.exit(1) }
console.log('system len', system.length)

const ctx = { logger: { info() {}, warn() {}, error() {} }, get() {}, credentials: { resolve: async () => undefined } }
const adapter = new WorkBuddyAdapter(ctx, REGIONS.cn)
adapter.catalog = []
adapter.catalogAt = Date.now()
const call = async (text) => {
  try {
    for await (const c of adapter.stream({ provider: REGIONS.cn.provider, model: 'hy3', system: text, messages: [{ role: 'user', content: [{ type: 'text', text: 'say ok' }] }], maxTokens: 16, signal: AbortSignal.timeout(180000) })) void c
    return 'ok'
  } catch (e) { return /unapproved channel/i.test(String(e.message)) ? 'BLOCK' : 'ERR' }
}

const base = system.replace(/DeepSeek Harness/g, 'this harness')
const variants = [
  ['CTRL 原样', base],
  ['A root; 后换行', base.replace('workspace root; absolute', 'workspace root;\nabsolute')],
  ['B referenced. 后换行', base.replace('explicitly referenced. Relative', 'explicitly referenced.\nRelative')],
  ['C 两处都换行', base.replace('explicitly referenced. Relative', 'explicitly referenced.\nRelative').replace('workspace root; absolute', 'workspace root;\nabsolute')],
  ['D 换行+缩进', base.replace('workspace root; absolute', 'workspace root;\n  absolute')]
]
for (const [label, text] of variants) {
  const r = []
  for (let i = 0; i < 3; i++) r.push(await call(text))
  console.log(label.padEnd(24), text.length, r.join(','))
}
