/**
 * Dev probe: run the real sweep path (as the host's automatic one does) for both
 * deployments and print what lands in the ledger — verifying the current probe
 * shapes, the daily/interval gate, and `lastSweepAt`.
 *
 * Run: `node test/live/sweep-check.mjs [--force]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { runSweep, sweepDue } from '../../src/availability.js'
import { fetchModelEntries } from '../../src/catalog.js'
import { REGIONS } from '../../src/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const yaml = readFileSync(credentialsPath, 'utf8')

const ctx = {
  logger: { info: (...args) => console.log('  ', ...args), warn: (...args) => console.log('  !', ...args), error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \\t]*${ref}:[ \\t]*(.+)$`, 'm').exec(yaml)
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    }
  }
}

const force = process.argv.includes('--force')
for (const region of [REGIONS.cn, REGIONS.intl]) {
  const interval = region.autoProbeIntervalMs ?? 24 * 3600_000
  const state = sweepDue(region.id, interval)
  console.log(`\n=== ${region.id} === 间隔 ${interval / 60000} 分钟 | 上次扫描 ${state.lastSweepAt ? new Date(state.lastSweepAt).toLocaleString() : '从未'} | 到期 ${state.due}`)
  if (state.due !== true && !force) {
    console.log('  未到期，跳过（这正是面板打开时的行为）')
    continue
  }
  const loaded = await fetchModelEntries(ctx, region)
  const ids = loaded.entries.map((entry) => entry.id)
  const started = Date.now()
  const result = await runSweep(ctx, region, ids, { minIntervalMs: interval, manual: force })
  if (result.skipped === true) {
    console.log('  被节流跳过（说明上次扫描在间隔内）')
    continue
  }
  const counts = new Map()
  for (const verdict of result.results) counts.set(verdict.state, (counts.get(verdict.state) ?? 0) + 1)
  console.log(`  ${result.results.length} 个模型，用时 ${((Date.now() - started) / 1000).toFixed(1)}s — ${[...counts.entries()].map(([state2, count]) => `${state2} ${count}`).join(' / ')}`)
  const odd = result.results.filter((verdict) => verdict.state !== 'ok' && verdict.state !== 'dead')
  console.log('  非 ok/dead:', odd.map((verdict) => `${verdict.id}=${verdict.state}(${verdict.detail})`).join(', ') || '无')
  console.log('  再次检查到期:', JSON.stringify(sweepDue(region.id, interval)))
}
