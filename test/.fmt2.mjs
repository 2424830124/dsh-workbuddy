/** The real formatter, exercised directly. */
import { readFileSync } from 'node:fs'

const source = readFileSync('client/index.js', 'utf8')
const start = source.indexOf('const formatTokens = (value) => {')
if (start === -1) throw new Error('formatter not found')
let depth = 0
let end = start
for (let index = start; index < source.length; index += 1) {
  if (source[index] === '{') depth += 1
  else if (source[index] === '}') {
    depth -= 1
    if (depth === 0) { end = index + 1; break }
  }
}
const formatTokens = new Function(`${source.slice(start, end)}; return formatTokens`)()

for (const value of [0, 640, 999, 1000, 12000, 32000, 64000, 131072, 192000, 256000, 1000000, 1048576, 1500000, 2000000]) {
  console.log(`  ${String(value).padStart(9)} → ${formatTokens(value)}`)
}
