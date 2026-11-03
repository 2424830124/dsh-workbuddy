/**
 * Dev tool: find definitions nothing references — CSS classes, dictionary keys,
 * module exports, and file-local helpers — so a cleanup pass works from a list
 * instead of from memory.
 *
 * Run: `node test/live/dead-code-report.mjs`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../../', import.meta.url).pathname.replace(/^\//, '')
const read = (path) => readFileSync(join(root, path), 'utf8')

const files = []
const walk = (dir) => {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules' || name === '.git') continue
    const rel = dir.length === 0 ? name : `${dir}/${name}`
    const stat = statSync(join(root, rel))
    if (stat.isDirectory()) { walk(rel); continue }
    if (/\.(js|mjs)$/.test(name)) files.push(rel.replace(/\\/g, '/'))
  }
}
walk('')

const sources = new Map(files.map((file) => [file, read(file)]))

// ---------- CSS classes ----------
const client = sources.get('client/index.js') ?? ''
const cssBlocks = [...client.matchAll(/^ {4}const CSS = `([\s\S]*?)`$/gm)].map((match) => match[1])
const css = cssBlocks.join('\n')
const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))
const jsx = client.slice(cssBlocks.reduce((total, block) => total + block.length, 0) === 0 ? 0 : 0)
const unusedCss = [...defined].filter((name) => {
  const inJsx = new RegExp(`['"\`][^'"\`]*\\b${name}\\b[^'"\`]*['"\`]`).test(client.replace(css, ''))
  return !inJsx
})

// ---------- dictionary keys ----------
const zhBlock = / {6}'zh-CN': \{([\s\S]*?)\n {6}\},\n {6}en: \{/.exec(client)?.[1] ?? ''
const enBlock = / {6}en: \{([\s\S]*?)\n {6}\}\n {4}\}/.exec(client)?.[1] ?? ''
const keyOf = (block) => [...block.matchAll(/^ {8}(\w+):/gm)].map((match) => match[1])
const zhKeys = keyOf(zhBlock)
const enKeys = keyOf(enBlock)
const clientBody = client.replace(zhBlock, '').replace(enBlock, '')
const unusedKeys = zhKeys.filter((key) => !new RegExp(`t\\(['"\`]${key}['"\`]`).test(clientBody))
const zhOnly = zhKeys.filter((key) => !enKeys.includes(key))
const enOnly = enKeys.filter((key) => !zhKeys.includes(key))

// ---------- module exports ----------
const exportsByFile = new Map()
for (const [file, text] of sources) {
  if (!file.startsWith('src/')) continue
  const names = [...text.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((match) => match[1])
  const list = [...text.matchAll(/^export \{([^}]+)\}/gm)].flatMap((match) => match[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop()))
  exportsByFile.set(file, [...new Set([...names, ...list])].filter((name) => name.length > 0))
}
const consumers = [...sources].filter(([file]) => !file.startsWith('src/'))
const unusedExports = []
for (const [file, names] of exportsByFile) {
  for (const name of names) {
    const pattern = new RegExp(`\\b${name}\\b`)
    const used = consumers.some(([, text]) => pattern.test(text)) ||
      [...sources].some(([other, text]) => other.startsWith('src/') && other !== file && pattern.test(text))
    if (!used) unusedExports.push(`${file} → ${name}`)
  }
}

// ---------- file-local helpers ----------
const unusedLocals = []
for (const [file, text] of sources) {
  if (!file.startsWith('src/') && file !== 'client/index.js') continue
  const locals = [...text.matchAll(/^ {2}(?:async )?function (\w+)|^ {4}(?:async )?function (\w+)|^ {2}const (\w+) = \(/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3])
  for (const name of new Set(locals)) {
    const uses = [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length
    if (uses <= 1) unusedLocals.push(`${file} → ${name}`)
  }
}

const report = []
report.push(`# 死代码报告`)
report.push(`\n## 定义了但 JSX/字符串里没用到的 CSS 类（${unusedCss.length}）`)
for (const name of unusedCss.sort()) report.push(`  .${name}`)
report.push(`\n## 词典里没被 t() 用到的键（${unusedKeys.length}）`)
for (const key of unusedKeys.sort()) report.push(`  ${key}`)
report.push(`\n## zh/en 不对称：仅中文 ${zhOnly.length}，仅英文 ${enOnly.length}`)
for (const key of zhOnly) report.push(`  仅中文: ${key}`)
for (const key of enOnly) report.push(`  仅英文: ${key}`)
report.push(`\n## src 里没人引用的导出（${unusedExports.length}）`)
for (const line of unusedExports.sort()) report.push(`  ${line}`)
report.push(`\n## 定义了但只出现一次的本文件函数（${unusedLocals.length}）`)
for (const line of unusedLocals.sort()) report.push(`  ${line}`)

console.log(report.join('\n'))
