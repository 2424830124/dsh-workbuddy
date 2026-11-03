/**
 * Dev probe: the declared kind of the composer's model seats — the slot contract
 * decides whether a plugin can replace the built-in selector or only decorate it
 * ("注册条目成为唯一被允许渲染该键的条目" for single; list/keyed take many).
 *
 * Run: `node test/live/model-seat-kind-probe.mjs`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_APP ?? 'D:/DSH Desktop/resources/app'
const seats = ['conversation.input.model', 'conversation.input.model.label', 'conversation.input.right', 'conversation.composer.bar', 'conversation.input.overlay']

const walk = (dir, depth, visit) => {
  if (depth > 5) return
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    const path = join(dir, name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) { walk(path, depth + 1, visit); continue }
    if (!/\.(js|d\.ts)$/.test(name) || stat.size > 6_000_000) continue
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    visit(text, path)
  }
}

for (const seat of seats) {
  console.log(`\n########## ${seat}`)
  let shown = 0
  walk(join(root, 'node_modules/@deepseek-ai'), 0, (text, path) => {
    if (shown >= 3) return
    const escaped = seat.replace(/\./g, '\\.')
    // 声明处通常形如： 'conversation.input.model': SingleSlot<...> / ListSlot<...>
    for (const match of text.matchAll(new RegExp(`["']${escaped}["']\\s*:\\s*([A-Za-z]+)`, 'g'))) {
      console.log(`  声明 ${path.replace(root, '.')} → kind=${match[1]}`)
      shown += 1
    }
    for (const match of text.matchAll(new RegExp(`declareSlot\\(\\s*["']${escaped}["']\\s*,\\s*["'](\\w+)["']`, 'g'))) {
      console.log(`  declareSlot ${path.replace(root, '.')} → kind=${match[1]}`)
      shown += 1
    }
    for (const match of text.matchAll(new RegExp(`register\\(\\{[^}]*name:\\s*["']${escaped}["'][^}]*\\}`, 'g'))) {
      console.log(`  注册 ${path.replace(root, '.')} → ${match[0].replace(/\s+/g, ' ').slice(0, 150)}`)
      shown += 1
    }
  })
  if (shown === 0) console.log('  （未找到声明或注册）')
}
