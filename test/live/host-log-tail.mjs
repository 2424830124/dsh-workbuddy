/**
 * Dev probe: read the host log as UTF-8 (PowerShell mangles it as ANSI) and show
 * the plugin's own lines, so the picker audit is actually visible.
 *
 * Run: `node test/live/host-log-tail.mjs [pattern] [count]`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.env.APPDATA ?? '', 'DSH Desktop', 'logs', 'host')
const newest = readdirSync(dir)
  .filter((name) => name.endsWith('.log'))
  .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0]

const pattern = process.argv[2] === undefined ? 'workbuddy' : process.argv[2]
const count = Number.parseInt(process.argv[3] ?? '12', 10)
const lines = readFileSync(join(dir, newest.name), 'utf8')
  .split('\n')
  .filter((line) => line.includes(pattern))

console.log(`${newest.name} — 含「${pattern}」的 ${lines.length} 行，末尾 ${count} 行：\n`)
for (const line of lines.slice(-count)) console.log(line.slice(0, 190))
