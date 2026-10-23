/**
 * The WorkBuddy model catalog, read live from the deployment.
 *
 * `/console/enterprises/personal/models` is the account-scoped catalog and the
 * preferred source; `/v3/config` publishes the same model metadata
 * deployment-wide and is the fallback. Neither is a local guess: when both
 * fail the catalog is empty and the panel says so, because a model list the
 * account cannot actually call is worse than none.
 *
 * Known availability (2026-10-21): China serves the scoped endpoint and
 * rejects plugin tokens on `/v3/config` (`12403`); international serves
 * `/v3/config` while its scoped endpoint answers 500 from the gateway. The
 * console-session variants of these routes (`…/personal/config`,
 * `…/personal/models/list`, `/console/as/users/private-configs/query`) need a
 * web cookie and answer 403 to a plugin token.
 */

import { readString, requestJson, responseData, responseMessage } from './http.js'
import { readToken } from './auth.js'

/**
 * @typedef {object} CatalogEntry
 * @property {string} id
 * @property {string} name
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {string[]} input              `['text']` or `['text','image']`
 * @property {Record<string,string>} [efforts]  level → wire spelling
 * @property {string} [defaultEffort]
 * @property {boolean} [thinking]          send `thinking: {type:'enabled'}`
 * @property {boolean} [preset]            router preset rather than a model
 */

/** Bare router aliases carry no metadata and are not selectable by id. */
const ALIAS_MODEL_IDS = new Set(['auto', 'default'])

/**
 * Whether an id belongs in the model picker.
 *
 * Bare router aliases are excluded on purpose. They *do* work when called
 * directly — China's `auto` answered and routed to `hy4-preview`, `default`
 * likewise — but the official pickers do not offer them: the China web list is
 * exactly the CLI whitelist minus `auto`, plus the 快速/均衡/极致 presets (its
 * international counterpart shows `default-model`, named "Auto", instead). So
 * the aliases stay callable for anything already pinned to them and simply are
 * not advertised. Applied when reading the on-disk cache as well, because the
 * cache appends and would otherwise resurrect them.
 */
export function isCatalogModelId(id) {
  return typeof id === 'string' && id.length > 0 && !ALIAS_MODEL_IDS.has(id)
}

/**
 * Whether an id may be *advertised* at all: not a bare alias, not a router
 * preset. Used wherever a list arrives from outside the catalog parsers (the
 * imported account list), so an import cannot reintroduce what the policy
 * deliberately keeps out.
 */
export function isAdvertisableId(id) {
  return isCatalogModelId(id) && !PRESET_MODEL_IDS.has(id)
}

/**
 * The admission policy for the picker, applied to the merged catalog and again
 * when reading the cache.
 *
 * 1. Bare aliases stop here ({@link isCatalogModelId}).
 * 2. **Router presets are out on both deployments.** `default-model` (shown as
 *    "Auto"), `fast-model`, `balanced-model`, `primary-model` and `deep-model`
 *    pick a backend per request and bill at a floating rate; they are not
 *    concrete models, so the picker offers the models themselves instead. They
 *    remain callable for anything already pinned to one.
 * 3. A model the **account-scoped** payload whitelists is kept whatever else is
 *    missing: that payload is the only list verified to match what the web
 *    picker offers (China: its 19 ids minus `auto` plus the three presets are
 *    exactly the 21 entries the picker shows).
 * 4. Everything else needs a **live credits rate** — the one signal that proves
 *    the model is actually for sale. `/v3/config` is a deployment list, so its
 *    models are admitted on price, not on membership.
 */
export function keepModel(entry) {
  if (!isCatalogModelId(entry?.id)) return false
  if (entry.preset === true) return false
  if (entry.official === true) return true
  return typeof entry.credits === 'string' && entry.credits.length > 0
}

/**
 * Router presets rather than concrete models: the picker lists them apart
 * because "Auto / Fast / Balanced / Primary / Deep" choose a backend at
 * request time and bill at a variable rate. Neither payload marks them, so the
 * known alias ids plus `isDefault` are the whole signal.
 */
const PRESET_MODEL_IDS = new Set([
  'auto',
  'default',
  'default-model',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model'
])

const isPresetModel = (id, meta) => PRESET_MODEL_IDS.has(id) || meta?.isDefault === true

/**
 * Reasoning levels in increasing depth. The server never sends them sorted, and
 * the harness renders the picker in array order, so every level list this
 * module produces is sorted by this table (`minimal` exists on the
 * international build's UI vocabulary).
 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const byEffortOrder = (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b)

/** Non-chat artifacts both payloads also list (completions, image models, tiny classifiers). */
/**
 * Tags that name a non-text output: `text-to-image`, `image-to-image`,
 * `text-to-video`, `image-to-video`. The payload has no output-modality field,
 * so the tag vocabulary is the signal — verified against `hunyuan-image-alpha`
 * (text-to-image), `hunyuan-image-alpha-edit` (image-to-image) and both video
 * models, in the scoped payload and `/v3/config` alike.
 */
const NON_CHAT_TAG = /(?:^|-)to-(?:image|video|audio|speech)$/i

/**
 * Whether a catalog id can serve a chat completion.
 *
 * The rules read the record, not the name — with one exception. Modality is
 * expressed by tags and flags, and those are authoritative:
 *
 * - `disabled: true` — upstream turned it off (`wb-lite`).
 * - `supportsExtra: true` — a side channel (completion, rewrite, classifier:
 *   `completion-gf`, `codewise-*`, `hunyuan-3b`, `hunyuan-7b-dense`).
 * - `videoGeneration: {…}` — a generator's parameter block.
 * - a `*-to-image` / `*-to-video` / `*-to-audio` tag — `hunyuan-image-alpha`,
 *   `hunyuan-image-alpha-edit`, `kling-video-v3`, `minimax-video-h3`.
 * - `maxOutputTokens ≤ 256` — small classifiers.
 *
 * The three id prefixes below are a narrow fallback for entries that carry none
 * of those flags; they name families that are non-chat by construction, and
 * without them such an entry reaches the picker and fails at request time.
 * (`hunyuan-image-alpha` is *not* handled this way: it does carry the tag, and
 * a name rule alone would have missed `hunyuan-image-alpha-edit`.)
 */
function isChatModel(id, meta) {
  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false
  if (meta?.disabled === true) return false
  if (meta?.supportsExtra === true) return false
  if (meta?.videoGeneration !== undefined) return false
  const tags = meta?.tags
  if (Array.isArray(tags) && tags.some((tag) => typeof tag === 'string' && NON_CHAT_TAG.test(tag))) return false
  const maxOutput = meta?.maxOutputTokens
  if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false
  return true
}

/**
 * One model record → a catalog entry.
 *
 * Both payloads use the same field names; they differ only in where the model
 * ids live (scoped: everything in `models[]`; config: `agents[].models` plus
 * `models[]`). The reasoning level set comes from `supportedEfforts` when the
 * server sends it, else from the single declared default.
 */
/**
 * One model record → a catalog entry.
 *
 * Both payloads use the same field names; they differ only in where the model
 * ids live (scoped: everything in `models[]`; config: `agents[].models` plus
 * `models[]`). The reasoning level set comes from `supportedEfforts` when the
 * server sends it, else from the single declared default.
 *
 * Fields the payload does not carry are **omitted**, never set to `undefined`:
 * these entries are merged (source against source, and read against the on-disk
 * cache), and an own property holding `undefined` would erase a value another
 * source had supplied.
 */
/**
 * One model record → a catalog entry.
 *
 * Exported because an imported console capture carries the same record shape as
 * the live payloads, and both must land in identical canonical fields.
 */
export function entryFromMeta(id, meta) {
  const reasoning = typeof meta?.reasoning === 'object' && meta.reasoning !== null ? meta.reasoning : undefined
  const levels = effortLevels(reasoning)
  const declared = declaredEffort(reasoning)
  const descriptionZh = readString(meta, 'descriptionZh')
  const descriptionEn = readString(meta, 'descriptionEn')
  const credits = readString(meta, 'credits')
  const entry = {
    id,
    name: readString(meta, 'name'),
    ...(descriptionZh.length === 0 ? {} : { descriptionZh }),
    ...(descriptionEn.length === 0 ? {} : { descriptionEn }),
    ...(credits.length === 0 ? {} : { credits }),
    ...(typeof meta?.maxInputTokens === 'number' ? { contextWindow: meta.maxInputTokens } : {}),
    ...(typeof meta?.maxOutputTokens === 'number' ? { maxTokens: meta.maxOutputTokens } : {}),
    input: meta?.supportsImages === true ? ['text', 'image'] : ['text'],
    ...(levels.length === 0 ? {} : { efforts: Object.fromEntries(levels.map((level) => [level, level])) }),
    ...(declared === undefined ? {} : { defaultEffort: declared }),
    // `reasoning.canDisableThinking` is deliberately ignored. Upstream publishes
    // the flag without naming any parameter that would act on it (measured
    // 2026-10-22, protocol §4.3.1), and it also stops sending the flag for models
    // it used to describe, so the plugin pins thinking on instead of advertising a
    // switch it cannot honour. The effort level is the only reasoning control.
    ...(id.startsWith('deepseek-') ? { thinking: true } : {}),
    // `/v3/config` publishes which tier a model needs; that is a free, static
    // entitlement signal (see `account-info.js`), so it is carried along.
    ...(typeof meta?.requiredUserType === 'string' && meta.requiredUserType.length > 0 ? { requiredUserType: meta.requiredUserType } : {}),
    preset: isPresetModel(id, meta)
  }
  // A single-source entry can carry a default without a list (`glm-5.2` on the
  // scoped payload) — normalise here so no consumer ever sees a mismatch.
  return withConsistentEfforts(entry)
}

/**
 * The ids an `agents[]` entry whitelists, most authoritative first.
 *
 * `agents[cli].models` is what the official CLI/IDE is allowed to offer, and it
 * is a **subset** of the catalog: China's scoped payload lists 34 models while
 * the CLI list holds 19, and four of the excluded ones answer a chat request
 * normally. So this is a preference order and a "officially sanctioned" marker,
 * never a filter.
 */
function whitelistedIds(agents) {
  if (!Array.isArray(agents)) return []
  for (const agentName of ['cli', 'craft']) {
    const agent = agents.find((entry) => typeof entry === 'object' && entry !== null && entry.name === agentName)
    if (agent === undefined || !Array.isArray(agent.models)) continue
    const ids = agent.models.filter((id) => typeof id === 'string' && id.length > 0)
    if (ids.length > 0) return ids
  }
  return []
}

/** `supportedEfforts` as a canonical-ordered list; `[]` when the server is silent. */
function effortLevels(reasoning) {
  if (!Array.isArray(reasoning?.supportedEfforts)) return []
  const levels = reasoning.supportedEfforts.filter((level) => typeof level === 'string' && level.length > 0)
  return [...new Set(levels)].sort(byEffortOrder)
}

/** The level to preselect: `defaultEffort` on config data, `effort` on scoped data. */
function declaredEffort(reasoning) {
  for (const key of ['defaultEffort', 'effort']) {
    const value = reasoning?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Keep `defaultEffort` inside `efforts`.
 *
 * The harness refuses an adapter whose preselected level is not one of the
 * model's supported levels ("adapter returned an unknown default reasoning
 * effort"), and that is a load-time failure for the whole provider — so this
 * pair is normalised wherever an entry is built or merged.
 *
 * The two payloads disagree in a way that produces exactly that mismatch: the
 * scoped block for `glm-5.2` says `{"effort":"medium"}` with no level list,
 * while `/v3/config` says `defaultEffort: "high"` over `["high","xhigh"]`.
 * Merging used to keep `medium` as the default while taking the config's list.
 *
 * Order of preference: the entry's own value when it is in the list, then any
 * candidate the caller offers (typically the other source's declared default),
 * then the first supported level.
 *
 * @param {object} entry
 * @param {(string | undefined)[]} candidates other sources' declared defaults
 */
export function withConsistentEfforts(entry, candidates = []) {
  const levels = entry.efforts === undefined ? [] : Object.keys(entry.efforts)
  if (levels.length === 0) {
    // No list: a lone default becomes a single-level set so the pair still
    // matches. With neither field there is nothing to say.
    const only = entry.defaultEffort
    return only === undefined ? entry : { ...entry, efforts: { [only]: only } }
  }
  if (entry.defaultEffort !== undefined && levels.includes(entry.defaultEffort)) return entry
  const picked = candidates.find((level) => typeof level === 'string' && levels.includes(level)) ?? levels[0]
  return entry.defaultEffort === picked ? entry : { ...entry, defaultEffort: picked }
}

/**
 * Fill each entry with what the other source knows.
 *
 * The two catalogs disagree on coverage, not on meaning: the scoped payload
 * listed 10 of 34 China models with an explicit level set while `/v3/config`
 * had sets for five of the remaining ones (`hy3`, `glm-5.2`, `deepseek-v4-*`,
 * `kimi-k3-1`), so merging recovers levels that are otherwise invisible. Only
 * fields the primary source left empty are taken, so scoped stays authoritative
 * for what it does declare.
 */
export function mergeEntries(entries, extra) {
  if (extra.length === 0) return entries
  const byId = new Map(extra.map((entry) => [entry.id, entry]))
  return entries.map((entry) => {
    const other = byId.get(entry.id)
    if (other === undefined) return entry
    const levels = [...new Set([...(entry.efforts === undefined ? [] : Object.keys(entry.efforts)), ...(other.efforts === undefined ? [] : Object.keys(other.efforts))])]
      .sort(byEffortOrder)
    const merged = {
      ...entry,
      ...(entry.descriptionZh === undefined && other.descriptionZh !== undefined ? { descriptionZh: other.descriptionZh } : {}),
      ...(entry.descriptionEn === undefined && other.descriptionEn !== undefined ? { descriptionEn: other.descriptionEn } : {}),
      ...(entry.credits === undefined && other.credits !== undefined ? { credits: other.credits } : {}),
      ...(entry.contextWindow === undefined && other.contextWindow !== undefined ? { contextWindow: other.contextWindow } : {}),
      ...(entry.maxTokens === undefined && other.maxTokens !== undefined ? { maxTokens: other.maxTokens } : {}),
      ...(entry.defaultEffort === undefined && other.defaultEffort !== undefined ? { defaultEffort: other.defaultEffort } : {}),
      ...(entry.promotion === undefined && other.promotion !== undefined ? { promotion: other.promotion } : {}),
      ...(levels.length === 0 ? {} : { efforts: Object.fromEntries(levels.map((level) => [level, level])) }),
      // `official` is only ever set by the account-scoped payload (see
      // `fetchScopedModelEntries`), so it is carried over from whichever side
      // has it and never invented here.
      ...(entry.official === true || other.official === true ? { official: true } : {}),
      // A modality either source advertised is kept: the two payloads disagree
      // on `supportsImages` for some models (glm-5.1), and the client that
      // omits it is the one that is wrong.
      input: entry.input.includes('image') || other.input.includes('image') ? ['text', 'image'] : ['text']
    }
    // The default may have come from the side whose level list was empty, or the
    // list from the other side: keep the pair consistent, preferring the other
    // source's declared default when it fits (`glm-5.2`: scoped says "medium",
    // config says "high" over ["high","xhigh"]).
    return withConsistentEfforts(merged, [other.defaultEffort])
  })
}

function catalogHeaders(region, token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-Domain': region.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': 'workbuddy',
    'User-Agent': region.userAgent
  }
}

/** The account-scoped catalog: full metadata, and the preferred source. */
async function fetchScopedModelEntries(ctx, region) {
  const token = await readToken(ctx, region)
  if (token.length === 0) throw new Error(`未登录 — 请先运行 /workbuddy login ${region.id}`)
  const { status, json } = await requestJson('GET', `${region.endpoint}/console/enterprises/personal/models`, catalogHeaders(region, token))
  if (status !== 200) throw new Error(`models HTTP ${status}${responseMessage(json) ? `: ${responseMessage(json)}` : ''}`)
  const data = responseData(json)
  const models = data?.models
  if (!Array.isArray(models)) return []
  const official = new Set(whitelistedIds(data?.agents))
  return models
    .filter((model) => typeof model === 'object' && model !== null)
    .map((model) => {
      const id = readString(model, 'id')
      return { id, meta: model }
    })
    .filter(({ id, meta }) => isCatalogModelId(id) && isChatModel(id, meta))
    .map(({ id, meta }) => {
      const entry = entryFromMeta(id, meta)
      return { ...entry, official: official.has(entry.id) }
    })
}

/**
 * The deployment-wide catalog. `agents[]` carries the selectable ids (the
 * `cli` agent first, then `craft`), `models[]` the metadata; a model present
 * only in `models[]` is still usable, so it is kept too.
 *
 * The `agents[]` list here orders the result but does **not** mark anything
 * `official`. It is a deployment/CLI list, and the international deployment
 * proved it is not the account's list: it carries ids the web picker never
 * shows (`gpt-6-astra`, `gpt-6-sol`, `grok-4.7`) and lacks ones it does show
 * (`gpt-5.3-codex`). Only the account-scoped payload can vouch for a model, so
 * `official` stays unset on this path and every model here has to earn its
 * place with a live rate.
 */
/**
 * The promotion attached to a model, if the deployment announces one.
 *
 * `modelPromotions[]` is a separate block whose entries name their models in
 * `modelIds`; the records themselves carry nothing. Only the parts worth showing
 * are kept — badge label and colour, the Chinese description, the discounted
 * rate and the end of the window — because the block also carries an inline SVG
 * icon that would bloat every catalog entry.
 */
function promotionFor(modelId, promotions) {
  if (!Array.isArray(promotions)) return undefined
  const active = promotions
    .filter((promotion) => promotion?.enabled !== false)
    .filter((promotion) => Array.isArray(promotion.modelIds) && promotion.modelIds.includes(modelId))
    .sort((a, b) => (typeof b?.priority === 'number' ? b.priority : 0) - (typeof a?.priority === 'number' ? a.priority : 0))[0]
  if (active === undefined) return undefined
  const label = readString(active.badge, 'label')
  const color = readString(active.badge, 'color')
  const text = readString(active.hover, 'textZh')
  const discounted = readString(active.discount, 'discountedCredits')
  const kind = readString(active, 'kind')
  const from = readString(active.schedule, 'validFrom')
  const until = readString(active.schedule, 'validUntil')
  if (label.length === 0 && text.length === 0 && discounted.length === 0) return undefined
  return {
    ...(label.length === 0 ? {} : { label }),
    ...(color.length === 0 ? {} : { color }),
    ...(text.length === 0 ? {} : { text }),
    ...(discounted.length === 0 ? {} : { discounted }),
    ...(kind.length === 0 ? {} : { kind }),
    ...(from.length === 0 ? {} : { from }),
    ...(until.length === 0 ? {} : { until })
  }
}

export function parseModelsFromConfig(json) {
  const data = responseData(json)
  if (data === undefined) return []
  const metaById = new Map()
  if (Array.isArray(data.models)) {
    for (const model of data.models) {
      if (typeof model !== 'object' || model === null) continue
      const id = readString(model, 'id')
      if (id.length > 0) metaById.set(id, model)
    }
  }
  const preferred = whitelistedIds(data.agents)
  const ids = []
  const seen = new Set()
  const push = (id) => {
    if (!isCatalogModelId(id) || seen.has(id)) return
    if (!isChatModel(id, metaById.get(id))) return
    seen.add(id)
    ids.push(id)
  }
  for (const id of preferred) push(id)
  for (const id of metaById.keys()) push(id)

  // Promotions are named by model id in their own block, so they are attached
  // here rather than parsed per record.
  return ids.map((id) => {
    const entry = entryFromMeta(id, metaById.get(id))
    const promotion = promotionFor(id, data.modelPromotions)
    return promotion === undefined ? entry : { ...entry, promotion }
  })
}

async function fetchConfigModelEntries(ctx, region) {
  const token = await readToken(ctx, region)
  if (token.length === 0) throw new Error(`未登录 — 请先运行 /workbuddy login ${region.id}`)
  const { status, json } = await requestJson('GET', `${region.endpoint}/v3/config`, catalogHeaders(region, token))
  if (status !== 200) throw new Error(`v3/config HTTP ${status}${responseMessage(json) ? `: ${responseMessage(json)}` : ''}`)
  return parseModelsFromConfig(json)
}

/**
 * The account's live model catalog.
 *
 * Both endpoints are asked in parallel: the scoped one defines *which* models
 * exist for this account, and `/v3/config` fills in what it left blank (level
 * sets, descriptions, credits). Asking them together costs one round trip
 * rather than two, and a source that fails only contributes a reason.
 *
 * @returns {Promise<{ entries: CatalogEntry[], source: 'scoped'|'config'|'none', reasons: string[] }>}
 */
export async function fetchModelEntries(ctx, region) {
  const reasons = []
  const attempt = async (name, fetchEntries) => {
    try {
      const entries = await fetchEntries(ctx, region)
      if (entries.length === 0) reasons.push(`${name}: 空目录`)
      return entries
    } catch (error) {
      reasons.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }
  const [scoped, config] = await Promise.all([
    attempt('scoped', fetchScopedModelEntries),
    attempt('config', fetchConfigModelEntries)
  ])
  const merge = (entries) => entries.filter(keepModel)
  if (scoped.length > 0) return { entries: merge(mergeEntries(scoped, config)), source: 'scoped', reasons }
  if (config.length > 0) return { entries: merge(config), source: 'config', reasons }
  return { entries: [], source: 'none', reasons }
}
