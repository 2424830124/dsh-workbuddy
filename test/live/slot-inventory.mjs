/**
 * Dev probe: enumerate the client slots the shipped Web UI actually renders, so
 * an extension question is answered from the surface rather than from memory.
 *
 * Run: `node test/live/slot-inventory.mjs [outFile]`
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_APP ?? 'D:/DSH Desktop/resources/app'
const renderSlots = new Map()
const declareSlots = new Map()
const modelSelectorFiles = []

const walk = (dir, depth) => {
  if (depth > 5) return
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const path = join(dir, name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) { walk(path, depth + 1); continue }
    if (!/\.js$/.test(name) || stat.size > 6_000_000) continue
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    for (const match of text.matchAll(/renderSlot\(\s*["']([\w.\-]+)["']/g)) {
      renderSlots.set(match[1], (renderSlots.get(match[1]) ?? 0) + 1)
    }
    for (const match of text.matchAll(/declareSlot\(\s*["']([\w.\-]+)["']/g)) {
      declareSlots.set(match[1], (declareSlots.get(match[1]) ?? 0) + 1)
    }
    if (/modelSelector|model-selector|模型选择/.test(text)) modelSelectorFiles.push(path)
  }
}

walk(join(root, 'lib'), 0)
walk(join(root, 'node_modules'), 0)

const lines = []
lines.push(`实际渲染的插槽（${renderSlots.size} 个）:`)
for (const [name, count] of [...renderSlots].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(count).padStart(3)}  ${name}`)
lines.push('')
lines.push(`声明的插槽（${declareSlots.size} 个）: ${[...declareSlots.keys()].sort().join(', ')}`)
lines.push('')
lines.push(`提到选择器的文件（${modelSelectorFiles.length} 个）:`)
for (const file of modelSelectorFiles.slice(0, 20)) lines.push(`  ${file}`)

const text = lines.join('\n')
console.log(text)
if (process.argv[2] !== undefined) writeFileSync(process.argv[2], text)
