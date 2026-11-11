/**
 * Dev probe: read the host log as UTF-8 (PowerShell mangles it as ANSI) and show
 * the plugin's own lines, so the picker audit is actually visible.
 *
 * The log has moved around: this build writes `desktop-next.log` under
 * `$DSH_HOME/logs`, while an install that never set `DSH_HOME` keeps it in the
 * Electron user-data folder. Both are tried, and `desktop-next.log` wins over
 * the rotated and crash logs sitting in the same directory.
 *
 * Run: `node test/live/host-log-tail.mjs [pattern] [count]`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dirs = [
  process.env.DSH_HOME === undefined || process.env.DSH_HOME.length === 0
    ? undefined
    : join(process.env.DSH_HOME, 'logs'),
  join(process.env.APPDATA ?? '', 'DSH Desktop', 'logs', 'host')
].filter((dir) => dir !== undefined)

const files = []
for (const dir of dirs) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    continue
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    const path = join(dir, name)
    try {
      files.push({ path, name, at: statSync(path).mtimeMs })
    } catch {
      // A log rotated away between the listing and the stat: not worth a branch.
    }
  }
}

const main = files.filter((file) => file.name === 'desktop-next.log')
const pool = main.length > 0 ? main : files
pool.sort((a, b) => b.at - a.at)
if (pool.length === 0) {
  console.error(`找不到宿主日志，找过：\n  ${dirs.join('\n  ')}`)
  process.exit(1)
}
const newest = pool[0]

const pattern = process.argv[2] === undefined ? 'workbuddy' : process.argv[2]
const count = Number.parseInt(process.argv[3] ?? '12', 10)
const lines = readFileSync(newest.path, 'utf8')
  .split('\n')
  .filter((line) => line.includes(pattern))

console.log(`${newest.path} — 含「${pattern}」的 ${lines.length} 行，末尾 ${count} 行：\n`)
for (const line of lines.slice(-count)) console.log(line.slice(0, 190))
