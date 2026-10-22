/**
 * Dev probe: grep the cached WorkBuddy web chunks (see web-bundle-probe.mjs)
 * for a pattern and print context, to trace a field back to its endpoint.
 *
 * Run: `node test/live/web-search.mjs busyLevel`
 */

import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs = [join(tmpdir(), 'wb-chunks'), tmpdir()]
const files = []
for (const dir of dirs) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue
    if (!name.startsWith('wb-') && dir === tmpdir()) continue
    files.push(join(dir, name))
  }
}

const sources = process.argv.slice(2)
if (sources.length === 0) {
  console.log('usage: node test/live/web-search.mjs <regex> [regex…]')
  process.exit(1)
}
const patterns = sources.map((source) => new RegExp(source, 'g'))

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    let printed = 0
    for (const match of text.matchAll(pattern)) {
      if (printed >= 4) break
      printed += 1
      console.log(`${file.split(/[\\/]/).pop()} :: ${match[0].replace(/\s+/g, ' ').slice(0, 460)}`)
    }
  }
}
