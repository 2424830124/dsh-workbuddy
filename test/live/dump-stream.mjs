/** Print the stored stream frames of specific events, verbatim. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`
const sessionsRoot = join(home, 'sessions')
const wantedSession = process.argv[2] ?? '6eb8dacf'
const wantedSeqs = (process.argv[3] ?? '27022,27017').split(',').map(Number)

let dir
for (const project of readdirSync(sessionsRoot)) {
  const projectDir = join(sessionsRoot, project)
  try { if (!readdirSync(projectDir).some((name) => name.includes(wantedSession))) continue } catch { continue }
  dir = join(projectDir, readdirSync(projectDir).find((name) => name.includes(wantedSession)))
  break
}

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const events = []
for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.zstd')).sort()) {
  const buffer = readFileSync(join(dir, name))
  const parts = []
  let at = buffer.indexOf(magic)
  while (at >= 0) {
    try { parts.push(zstdDecompressSync(buffer.subarray(at))) } catch { /* torn */ }
    at = buffer.indexOf(magic, at + 4)
  }
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try { events.push(JSON.parse(line)) } catch { /* torn */ }
  }
}
events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

for (const seq of wantedSeqs) {
  const event = events.find((entry) => entry.seq === seq)
  if (event === undefined) { console.log(`seq ${seq}: 未找到`); continue }
  console.log(`\n===== seq ${event.seq} ${event.type}  turn ${event.data?.turn} step ${event.data?.step}`)
  const stream = event.data?.stream
  if (!Array.isArray(stream)) { console.log('（没有 stream 字段）'); continue }
  stream.forEach((frame, index) => {
    const chunk = frame.chunk ?? frame
    const shape = { ...frame }
    delete shape.chunk
    console.log(`  [${index}] ${chunk?.type ?? '?'}  ${Object.keys(shape).length > 0 ? `frame=${JSON.stringify(shape).slice(0, 100)}` : ''}`)
    console.log(`       ${JSON.stringify(chunk).slice(0, 420)}`)
  })
  const message = event.data?.message
  if (message !== undefined) console.log(`  message: ${JSON.stringify(message).slice(0, 300)}`)
}
