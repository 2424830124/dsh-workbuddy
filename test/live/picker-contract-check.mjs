/**
 * Dev probe: what the model picker would receive — the adapter's own answers for
 * `providerInfo`, `listModels` and `resolveModel`, for both deployments.
 *
 * Run: `node test/live/picker-contract-check.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/adapter.js'
import { REGIONS } from '../../src/regions.js'

const credentialsPath = process.env.DSH_HOME ? `${process.env.DSH_HOME}/.credentials.yaml` : `${homedir()}/.dsh/.credentials.yaml`
const yaml = readFileSync(credentialsPath, 'utf8')

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: {
    resolve: async (ref) => {
      const match = new RegExp(`^[ \\t]*${ref}:[ \\t]*(.+)$`, 'm').exec(yaml)
      return match === null ? undefined : { value: match[1].trim().replace(/^["']|["']$/g, '') }
    },
    set: async () => {}
  },
  get: () => undefined
}

for (const region of [REGIONS.cn, REGIONS.intl]) {
  const adapter = new WorkBuddyAdapter(ctx, region)
  console.log(`\n=== ${region.id} · provider ${region.provider} ===`)
  try {
    console.log('providerInfo:', JSON.stringify(adapter.providerInfo(region.provider)))
  } catch (error) {
    console.log('providerInfo THREW:', String(error).slice(0, 120))
  }
  try {
    const models = await adapter.listModels(region.provider)
    console.log(`listModels → ${models.length} 个`)
    console.log('  前 5:', models.slice(0, 5).map((model) => `${model.id}(${model.inputModalities.join('+')})`).join(', '))
    if (models.length === 0) {
      const all = await adapter.models()
      console.log(`  ⚠ 但目录里有 ${all.length} 个，说明被开关过滤干净了`)
      for (const entry of all.slice(0, 6)) console.log('    ', entry.id, 'state=', entry.availability?.state ?? '-')
    }
    const first = models[0]
    if (first !== undefined) {
      const resolved = await adapter.resolveModel(region.provider, first.id)
      console.log('resolveModel:', JSON.stringify({
        id: resolved.id,
        efforts: (resolved.supportedReasoningEfforts ?? []).map((level) => level.id ?? level),
        default: resolved.defaultReasoningEffort,
        inputModalities: resolved.inputModalities
      }))
    }
  } catch (error) {
    console.log('listModels THREW:', error instanceof Error ? `${error.message}\n${error.stack?.split('\n')[1] ?? ''}` : String(error))
  }
}
