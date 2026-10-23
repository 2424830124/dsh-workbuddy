/**
 * Dev probe: replay the harness's own validation over everything our adapter
 * answers.
 *
 * The model picker builds its catalog per provider and keeps only groups that
 * answer without throwing (`buildModelCatalog` isolates failures), so a single
 * invalid entry hides *every* WorkBuddy model. The rules below are copied from
 * `@deepseek-ai/dsh-llm`:
 *
 * - `listModels`: provider/id/name strings, id and name non-empty, no duplicate
 *   ids (`INVALID_CATALOG`)
 * - `resolveModel`: provider and id must echo the request, a non-empty name, an
 *   integer positive `context.contextWindow`, a positive `defaultMaxTokens`,
 *   `inputModalities` present-if-defined, and `reasoning.efforts` non-empty with
 *   unique ids and a default that is one of them (`INVALID_MODEL_REASONING`)
 *
 * Run: `node test/live/harness-contract-replay.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { WorkBuddyAdapter } from '../../src/llm/adapter.js'
import { REGIONS } from '../../src/core/regions.js'

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

/** The harness's `listModels` validation. */
function validateCatalog(provider, models) {
  const seen = new Set()
  for (const model of models) {
    const fail = (why) => `${model?.id ?? '?'}: ${why}`
    if (typeof model.provider !== 'string' || model.provider !== provider) return fail('provider mismatch')
    if (typeof model.id !== 'string' || model.id.length === 0) return fail('empty id')
    if (typeof model.name !== 'string' || model.name.length === 0) return fail('empty name')
    if (seen.has(model.id)) return fail('duplicate id')
    seen.add(model.id)
  }
  return undefined
}

/** The harness's `normalizeModelInfo` validation. */
function validateResolved(provider, model, resolved) {
  const fail = (why) => `${model}: ${why}`
  if (resolved.provider !== provider || resolved.id !== model) return fail('identity mismatch')
  if (typeof resolved.name !== 'string' || resolved.name.length === 0) return fail('empty name')
  const context = resolved.context
  if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) return fail('bad contextWindow')
  const max = resolved.defaultMaxTokens
  if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0)) return fail('bad defaultMaxTokens')
  const reasoning = resolved.reasoning
  if (reasoning === undefined) return undefined
  if (!Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return fail('reasoning with no efforts')
  const seen = new Set()
  for (const effort of reasoning.efforts) {
    if (typeof effort.id !== 'string' || effort.id.length === 0) return fail('effort without id')
    if (typeof effort.name !== 'string' || effort.name.length === 0) return fail(`effort ${effort.id} without name`)
    if (seen.has(effort.id)) return fail(`duplicate effort ${effort.id}`)
    seen.add(effort.id)
  }
  if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) return fail(`default ${reasoning.defaultEffort} not in efforts`)
  return undefined
}

let failures = 0
for (const region of [REGIONS.cn, REGIONS.intl]) {
  const adapter = new WorkBuddyAdapter(ctx, region)
  const models = await adapter.listModels(region.provider)
  const catalogProblem = validateCatalog(region.provider, models)
  console.log(`\n=== ${region.id} · ${models.length} 个 ===`)
  console.log(catalogProblem === undefined ? '  listModels 校验通过 ✓' : `  ✗ listModels 违规 → ${catalogProblem}`)
  if (catalogProblem !== undefined) failures += 1
  for (const model of models) {
    const resolved = await adapter.resolveModel(region.provider, model.id)
    const problem = validateResolved(region.provider, model.id, resolved)
    if (problem !== undefined) {
      failures += 1
      console.log(`  ✗ resolveModel ${problem}  → ${JSON.stringify(resolved).slice(0, 160)}`)
    }
  }
}

console.log(`\n总违规: ${failures}`)
if (failures > 0) process.exitCode = 1
