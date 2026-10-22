/**
 * Pre-publication leak scan.
 *
 * Answers one question before this repository goes public: does any tracked file
 * — now or at any point in history — carry the maintainer's account facts, a
 * credential, or a personal path?
 *
 * The needles are assembled from fragments so this file never contains them
 * itself; a scanner that leaks what it looks for is worse than no scanner.
 *
 * Run: `node test/live/leak-scan.mjs [ref]`
 *   Without a ref it scans the working tree and every branch's history. With a
 *   ref (e.g. the single-commit branch prepared for publication) it checks that
 *   ref alone, which is the question that matters before `git push`.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** [label, regex source] — every needle is built, never written down whole. */
const patterns = [
  ['昵称', '懷' + '信'],
  ['账号 ID', '242483' + '0124'],
  ['积分余额', '1293' + '\\.50|367' + '\\.49|367' + '\\.53'],
  ['到期时间', '2026/11/16' + ' 21:17|2027/10/21' + ' 11:38'],
  // Only a path segment leaks the OS account name; the same string is the public
  // npm scope in `@huai_xin/dsh-workbuddy`, which is meant to be here.
  ['本机用户路径', '[\\\\/]huai' + '_xin'],
  ['中文用户目录', 'E:' + '\\\\\\\\用户|E:/' + '用户'],
  ['会话 id', 'session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'],
  ['JWT', 'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}'],
  ['Cookie 赋值', '(console_)?(sid|sessionid|ticket|skey|p_skey)=[A-Za-z0-9%._-]{8,}'],
  ['个人绝对路径', '[A-Z]:' + '\\\\\\\\Users' + '\\\\\\\\[A-Za-z0-9_.-]+'],
  // POSIX ERE (git grep) has no non-capturing groups, so this stays plain.
  ['邮箱', '[A-Za-z0-9._%+-]+@(qq|gmail|outlook|163|126)[.]com']
]

const files = []
const walk = (dir) => {
  for (const name of readdirSync(join(root, dir === '' ? '.' : dir))) {
    if (name === 'node_modules' || name === '.git') continue
    const rel = dir === '' ? name : `${dir}/${name}`
    const stat = statSync(join(root, rel))
    if (stat.isDirectory()) { walk(rel); continue }
    files.push(rel.replace(/\\/g, '/'))
  }
}
walk('')

/**
 * The maintainer's GitHub login and npm scope are public and must appear in
 * repository URLs and install commands; only the same strings in any *other*
 * context are leaks. Kept as one place so both scans agree.
 */
const allowedContext = /(github\.com\/|github:)2424830124|@huai_xin\/dsh-workbuddy|huai_xin@github/
const isAllowed = (line) => allowedContext.test(line)

// ---------- working tree ----------
const treeHits = []
for (const file of files) {
  if (/\.(png|webp|jpg|jpeg|gif|ico|tgz)$/i.test(file)) continue
  const text = readFileSync(join(root, file), 'utf8')
  text.split('\n').forEach((line, index) => {
    if (isAllowed(line)) return
    for (const [label, pattern] of patterns) {
      if (new RegExp(pattern, 'i').test(line)) {
        treeHits.push({ label, where: `${file}:${index + 1}`, line: line.trim().slice(0, 130) })
      }
    }
  })
}

// ---------- git history ----------
const ref = process.argv[2]
const revisions = git('rev-list', ...(ref === undefined ? ['--all'] : [ref])).split('\n').filter((line) => line.length > 0)
const historyHits = []
for (const [label, pattern] of patterns) {
  let output = ''
  try {
    // `-n` (not `-c`) so each hit can be judged in context like the tree scan.
    output = git('grep', '-I', '-n', '-E', '-i', pattern, ...revisions)
  } catch (error) {
    output = String(error.stdout ?? '')
  }
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue
    const match = /^([0-9a-f]{40}):([^:]+):(\d+):(.*)$/.exec(line)
    if (match === null) { historyHits.push({ label, where: line.trim().slice(0, 80) }); continue }
    if (isAllowed(match[4])) continue
    historyHits.push({ label, where: `${match[2]}:${match[3]}`, line: match[4].trim().slice(0, 130), revision: match[1].slice(0, 7) })
  }
}

// ---------- files that must never be tracked ----------
const tracked = git('ls-files').split('\n').filter((line) => line.length > 0)
const suspicious = tracked.filter((file) => /(^|\/)(\.token|\.credentials[^/]*|\.env[^/]*)$/.test(file) || /\.jsonl$/.test(file))
const ignoredButPresent = files.filter((file) => !tracked.includes(file) && /(^|\/)\.(token|credentials[^/]*)$/.test(file))

const report = []
report.push('# 泄露扫描')
report.push(`\n范围：${ref === undefined ? '工作区 + 全部历史' : `仅 ${ref}`}`)
report.push(`\n## 工作区（${treeHits.length} 处）`)
for (const hit of treeHits) report.push(`  [${hit.label}] ${hit.where}\n      ${hit.line}`)
if (treeHits.length === 0) report.push('  干净 ✓')

report.push(`\n## git 历史（${historyHits.length} 处）`)
if (historyHits.length === 0) report.push('  干净 ✓')
const byLabel = new Map()
for (const hit of historyHits) byLabel.set(hit.label, (byLabel.get(hit.label) ?? 0) + 1)
for (const [label, count] of byLabel) report.push(`  [${label}] ${count} 个文件版本仍带着它`)
if (historyHits.length > 0) report.push('  → 发布前需要一份**干净的历史**（见报告末尾）')

report.push(`\n## 被跟踪的可疑文件（${suspicious.length}）`)
for (const file of suspicious) report.push(`  ${file}`)
if (suspicious.length === 0) report.push('  无 ✓')
report.push(`\n## 存在于磁盘但未被跟踪的敏感文件（${ignoredButPresent.length}）`)
for (const file of ignoredButPresent) report.push(`  ${file}（已忽略；不会随 git 发布）`)

// Commit metadata is public too: an author email can carry what the files no
// longer do. Listed as information, not a failure — the maintainer may accept it.
const authors = [...new Set(git('log', '--format=%an <%ae>', ...(ref === undefined ? ['--all'] : [ref])).split('\n').filter((line) => line.length > 0))]
const riskyAuthors = authors.filter((author) => patterns.some(([, pattern]) => new RegExp(pattern, 'i').test(author)))
report.push(`\n## 提交元数据里的作者（${authors.length}）`)
for (const author of authors) report.push(`  ${author}${riskyAuthors.includes(author) ? '  ← 邮箱里带着被清理过的串，介意的话换一个' : ''}`)

console.log(report.join('\n'))
if (treeHits.length > 0) process.exitCode = 1
