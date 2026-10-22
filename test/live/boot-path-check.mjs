/**
 * Dev probe: run the plugin's own `apply()` against a minimal fake context and
 * watch what the boot timers actually do — this is the code path that would log
 * the picker audit in the host.
 *
 * Run: `node test/live/boot-path-check.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const yaml = readFileSync(credentialsPath, 'utf8')

const logs = []
const logger = {
  info: (message) => { logs.push(`[I] ${message}`); console.log('[I]', message) },
  warn: (message) => { logs.push(`[W] ${message}`); console.log('[W]', message) },
  error: (message) => { logs.push(`[E] ${message}`); console.log('[E]', message) }
}

const credentials = {
  resolve: async (ref) => {
    const match = new RegExp(`^[ \\t]*${ref}:[ \\t]*(.+)$`, 'm').exec(yaml)
    return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
  },
  set: async () => {}
}

const ctx = {
  logger,
  credentials,
  get: (name) => (name === 'credentials' ? credentials : undefined),
  effect: () => {},
  inject: () => {},
  llm: { registerAdapter: (providers) => { console.log('[llm] registered', providers.join(', ')) } },
  commands: { register: () => {} }
}

process.on('uncaughtException', (error) => {
  console.log('[uncaught]', error instanceof Error ? `${error.message}\n${error.stack?.split('\n').slice(0, 3).join('\n')}` : String(error))
  process.exitCode = 1
})

const { apply } = await import('../../src/index.js')
apply(ctx)
console.log('apply() 返回，等待启动定时器（8s / 15s / 45s）…')

await new Promise((resolve) => setTimeout(resolve, 52_000))
console.log(`\n共 ${logs.length} 条日志，含「选择器」的 ${logs.filter((line) => line.includes('选择器')).length} 条`)
for (const line of logs.filter((entry) => entry.includes('选择器'))) console.log(line)
process.exit(0)