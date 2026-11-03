/**
 * Verify an installed copy of the package, not the working tree: import the
 * plugin from the profile's node_modules and run `apply()` against a fake
 * context. This is what catches a `files` list that forgot a runtime asset.
 *
 * Run: `node test/live/installed-package-check.mjs [installDir]`
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const installed = process.argv[2] ?? join(homedir(), '.dsh/profiles/engineer/node_modules/dsh-workbuddy')
console.log(`检查安装副本: ${installed}`)

const entry = join(installed, 'src/index.js')
if (!existsSync(entry)) {
  console.error(`✗ 找不到入口 ${entry}`)
  process.exit(1)
}

// The package must not depend on anything outside itself.
const packageJson = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
console.log(`包名/版本: ${packageJson.name}@${packageJson.version}`)
console.log(`依赖: ${JSON.stringify(packageJson.dependencies ?? {})} （应为空）`)
console.log(`客户端半边: ${JSON.stringify(packageJson.dsh?.client ?? null)}`)

const credentialsPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
const credentials = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : ''

const logs = []
const logger = {
  info: (message) => { logs.push(`I ${message}`); console.log('I', message) },
  warn: (message) => { logs.push(`W ${message}`) },
  error: (message) => { logs.push(`E ${message}`); console.error('E', message) }
}

const credentialService = {
  resolve: async (ref) => {
    const match = new RegExp(`^[ \\t]*${ref}:[ \\t]*(.+)$`, 'm').exec(credentials)
    return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
  },
  set: async () => {}
}

const registered = []
const ctx = {
  logger,
  credentials: credentialService,
  get: (name) => (name === 'credentials' ? credentialService : undefined),
  effect: () => {},
  inject: () => {},
  llm: {
    registerAdapter: (providers, adapter) => {
      // The harness registry touches these two during registration.
      const info = adapter.providerInfo(providers[0])
      const policy = adapter.providerRetryPolicy(providers[0])
      if (info?.id !== providers[0] || typeof info.name !== 'string') throw new Error('bad providerInfo')
      if (policy !== undefined) throw new Error('unexpected retry policy')
      registered.push({ providers, adapter })
    }
  },
  commands: { register: () => {} }
}

const { apply, inject } = await import(`file:///${entry.replace(/\\/g, '/')}`)
console.log(`inject: ${JSON.stringify(inject)}`)
apply(ctx)

console.log(`\n注册的 provider 路由: ${registered.flatMap((entry) => entry.providers).join(', ')}`)
if (registered.length !== 2) {
  console.error('✗ 应有 2 个 provider 路由')
  process.exit(1)
}

// What the model picker would be offered, from the installed copy.
for (const { providers, adapter } of registered) {
  const provider = providers[0]
  const audit = await adapter.auditPicker(provider)
  console.log(`${provider}: 可选项 ${audit.models} 个，契约违规 ${audit.problems.length} 个`)
  for (const problem of audit.problems) console.log(`  ✗ ${problem}`)
  if (audit.problems.length > 0) process.exitCode = 1
}

// The two icon assets the panel and the plugin inventory need.
for (const asset of ['icon.webp', 'icon-mask.png', 'cordis.patch.yml', 'client/index.js', 'locale/zh.json', 'locale/en.json']) {
  console.log(`${existsSync(join(installed, asset)) ? '✓' : '✗'} ${asset}`)
  if (!existsSync(join(installed, asset))) process.exitCode = 1
}

console.log('\n安装副本检查完毕')
