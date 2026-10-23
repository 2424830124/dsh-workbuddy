/**
 * Unit check for the catalog fallback that keeps the international
 * deployment's model list alive: `/console/enterprises/personal/models` has
 * been answering 500 since 2026-10-21, so `fetchModelEntries` must fall back
 * to `/v3/config` (and still prefer scoped when it answers).
 *
 * Run: `node test/catalog.mjs`
 */

import assert from 'node:assert/strict'
import { fetchModelEntries, mergeEntries as mergeForTest, parseModelsFromConfig } from '../../src/catalog/catalog.js'
import { REGIONS } from '../../src/core/regions.js'

// The plugin keeps its own credentials document now (src/paths.js), so the fixture seeds
// that instead of a fake credentials service.
const { setCredential } = await import('../../src/core/paths.js')
setCredential(REGIONS.intl.tokenRef, 'header.payload.signature')
setCredential(REGIONS.cn.tokenRef, 'header.payload.signature')

const configPayload = {
  code: 0,
  data: {
    agents: [
      { name: 'cli', models: ['default-model', 'hy3', 'gpt-5.6-sol', 'auto'] },
      { name: 'craft', models: ['never-reached'] }
    ],
    models: [
      { id: 'hy3', name: 'Hy3', credits: 'x0.00 credits', maxInputTokens: 192000, maxOutputTokens: 64000, supportsImages: true, reasoning: { defaultEffort: 'high' } },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', credits: 'x3.47 credits', maxInputTokens: 1000000, maxOutputTokens: 128000, supportsImages: true, reasoning: {} },
      { id: 'default-model', name: 'Auto', maxOutputTokens: 24000 },
      { id: 'completion-xyz', name: 'Completion', maxOutputTokens: 4000 },
      { id: 'hy4-preview-f', name: 'Hy4 preview', maxInputTokens: 1000000, maxOutputTokens: 64000, reasoning: { defaultEffort: 'high' } }
    ]
  }
}

const parsed = parseModelsFromConfig(configPayload)
// `default-model` is a real selectable alias; only bare `auto` / `default` are
// dropped, plus non-chat ids. The `agents[]` order still leads the result.
assert.deepEqual(parsed.map((entry) => entry.id), ['default-model', 'hy3', 'gpt-5.6-sol', 'hy4-preview-f'], 'cli order first, aliases and non-chat ids dropped')
// The deployment list orders models but vouches for none of them: only the
// account-scoped payload may set `official` (see keepModel).
assert.ok(parsed.every((entry) => entry.official === undefined), 'a deployment list marks nothing official')
assert.equal(parsed[1].name, 'Hy3')
assert.equal(parsed[1].contextWindow, 192000)
assert.equal(parsed[1].maxTokens, 64000)
assert.deepEqual(parsed[1].input, ['text', 'image'], 'supportsImages maps to the image modality')
// Only `supportedEfforts` produces a multi-level list. A lone declared default
// becomes a one-level set instead of staying detached from it: the harness
// refuses an adapter whose default is not among the model's supported levels
// (`glm-5.2` failed to load that way), so the pair is always made consistent.
assert.deepEqual(parsed[1].efforts, { high: 'high' }, 'a declared default alone becomes a single-level set')
assert.equal(parsed[1].defaultEffort, 'high', 'the declared default is still recorded')
assert.equal(parsed[2].efforts, undefined, 'a model without reasoning metadata carries no levels')
assert.equal(parsed[2].defaultEffort, undefined)
// Router presets stay in the catalog but are flagged so the panel lists them
// apart from concrete models.
assert.equal(parsed[0].preset, true, 'default-model is a preset')
assert.equal(parsed[1].preset, false, 'hy3 is a concrete model')
// Two sources can disagree in a way that breaks the default↔levels pair: the
// scoped block for `glm-5.2` declares `{"effort":"medium"}` with no list while
// the deployment config declares `"high"` over `["high","xhigh"]`. Merging must
// not leave `medium` preselected over a list that does not contain it.
const mismatched = mergeForTest(
  [{ id: 'glm-5.2', name: 'GLM-5.2', input: ['text'], defaultEffort: 'medium' }],
  [{ id: 'glm-5.2', name: 'GLM-5.2', input: ['text'], efforts: { high: 'high', xhigh: 'xhigh' }, defaultEffort: 'high' }]
)
assert.deepEqual(Object.keys(mismatched[0].efforts), ['high', 'xhigh'])
assert.equal(mismatched[0].defaultEffort, 'high', 'the other source default wins when it fits the merged list')
// `supportedEfforts` is authoritative when present: it is the only source of
// multi-level reasoning now that no local table stands behind the catalog.
const withEfforts = parseModelsFromConfig({
  code: 0,
  data: { agents: [{ name: 'cli', models: ['ds-x'] }], models: [
    { id: 'ds-x', name: 'DS X', maxInputTokens: 1000, maxOutputTokens: 4096, supportsReasoning: true, reasoning: { defaultEffort: 'medium', supportedEfforts: ['low', 'medium', 'high'] } }
  ] }
})
assert.deepEqual(withEfforts[0].efforts, { low: 'low', medium: 'medium', high: 'high' })
assert.equal(withEfforts[0].defaultEffort, 'medium')

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  credentials: { resolve: async () => undefined }
}

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
})

// Both endpoints are asked in parallel. Scoped is down (the live international
// behaviour) → config alone answers.
const calls = []
globalThis.fetch = async (url) => {
  const target = String(url)
  calls.push(target)
  if (target.includes('/console/enterprises/personal/models')) {
    return new Response('<html>500 Internal Server Error</html>', { status: 500 })
  }
  if (target.includes('/v3/config')) return jsonResponse(configPayload)
  throw new Error(`unexpected fetch: ${target}`)
}
const fallback = await fetchModelEntries(ctx, REGIONS.intl)
assert.equal(fallback.source, 'config')
// A deployment list admits models on price: `hy4-preview-f` publishes no rate,
// and `default-model` is a router preset, so the policy drops both.
assert.deepEqual(fallback.entries.map((entry) => entry.id), ['hy3', 'gpt-5.6-sol'])
assert.ok(fallback.entries.every((entry) => entry.official === undefined), 'nothing from a deployment list is called official')
assert.match(fallback.reasons[0], /models HTTP 500/)
assert.equal(calls.length, 2)

// Scoped answers → it defines the list, and config fills in what scoped left
// blank (here: hy3's level set, which the real scoped payload omits).
const scopedPayload = {
  code: 0,
  data: {
    agents: [{ name: 'cli', models: ['hy3', 'scoped-only'] }],
    models: [
      { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 64000, supportsImages: true, supportsReasoning: true, reasoning: { effort: 'high' } },
      { id: 'scoped-only', name: 'Scoped Only', maxInputTokens: 1000, maxOutputTokens: 512, reasoning: { supportedEfforts: ['low', 'medium'] } }
    ]
  }
}
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/console/enterprises/personal/models')) return jsonResponse(scopedPayload)
  if (target.includes('/v3/config')) {
    return jsonResponse({ code: 0, data: { models: [
      { id: 'hy3', name: 'Hy3', descriptionZh: '混元思考模型', credits: 'x0.00 credits', reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high'] } },
      { id: 'config-only', name: 'Config Only', maxInputTokens: 2000, maxOutputTokens: 512, reasoning: { supportedEfforts: ['high', 'max'] } }
    ] } })
  }
  throw new Error(`unexpected fetch: ${target}`)
}
const merged = await fetchModelEntries(ctx, REGIONS.intl)
assert.equal(merged.source, 'scoped', 'scoped defines the model list')
assert.deepEqual(merged.entries.map((entry) => entry.id), ['hy3', 'scoped-only'], 'config-only ids do not join the list')
assert.equal(merged.entries[0].official, true, 'the account-scoped list is what vouches for a model')
assert.equal(merged.entries[0].contextWindow, 192000, 'scoped keeps its own values')
assert.equal(merged.entries[0].descriptionZh, '混元思考模型', 'config fills a field scoped omitted')
assert.equal(merged.entries[0].credits, 'x0.00 credits')
assert.deepEqual(merged.entries[0].efforts, { low: 'low', high: 'high' }, 'level sets come from whichever source has them, in canonical order')
assert.equal(merged.entries[0].defaultEffort, 'high')
assert.deepEqual(merged.entries[1].efforts, { low: 'low', medium: 'medium' }, 'a scoped level set is not replaced by the config default')
assert.equal(merged.entries[1].descriptionZh, undefined, 'nothing is invented for a model config does not know')

// The admission policy, end to end: an account-scoped model passes without a
// rate, anything else needs one, aliases and presets never pass.
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/console/enterprises/personal/models')) {
    return jsonResponse({ code: 0, data: {
      agents: [{ name: 'cli', models: ['hy3', 'default-model'] }],
      models: [
        { id: 'hy3', name: 'Hy3', maxOutputTokens: 64000 },
        { id: 'unlisted-free', name: 'Unlisted, unpriced', maxOutputTokens: 64000 },
        { id: 'unlisted-priced', name: 'Unlisted, priced', maxOutputTokens: 64000 },
        { id: 'auto', name: 'Auto', isDefault: true, maxOutputTokens: 64000 },
        { id: 'default-model', name: 'Auto', maxOutputTokens: 24000 },
        { id: 'hunyuan-image-alpha', name: 'Image', maxOutputTokens: 64000 }
      ]
    } })
  }
  if (target.includes('/v3/config')) {
    return jsonResponse({ code: 0, data: { models: [
      { id: 'unlisted-priced', name: 'Unlisted, priced', credits: 'x0.20 credits', maxOutputTokens: 64000 }
    ] } })
  }
  throw new Error(`unexpected fetch: ${target}`)
}
const admitted = await fetchModelEntries(ctx, REGIONS.intl)
assert.deepEqual(admitted.entries.map((entry) => entry.id), ['hy3', 'unlisted-priced'], 'the account list first, then priced models')
assert.equal(admitted.entries[0].official, true, 'the account-scoped payload vouches for hy3')
assert.equal(admitted.entries[1].official, false, 'a priced deployment model is admitted, not vouched for')
assert.equal(admitted.entries[1].credits, 'x0.20 credits', 'the rate comes from the other source and still admits it')
assert.ok(!admitted.entries.some((entry) => entry.id === 'default-model'), 'a preset is dropped even when the account list names it')
assert.ok(!admitted.entries.some((entry) => entry.id === 'unlisted-free'), 'an unpriced model outside the account list is dropped')

// Both down → no entries, but every reason is reported for the log.
globalThis.fetch = async () => new Response('nope', { status: 502 })
const dead = await fetchModelEntries(ctx, REGIONS.intl)
assert.equal(dead.source, 'none')
assert.equal(dead.entries.length, 0)
assert.equal(dead.reasons.length, 2)

console.log('catalog.mjs: OK — parallel scoped/config fetch, merge, and fallback verified')
