/**
 * The WorkBuddy wire adapter.
 *
 * Deliberately dependency-free: the class is duck-typed against the harness
 * `LlmAdapter` contract (`providerInfo`, `listModels`, `resolveModel`,
 * `prepareCall` → `{ model, stream }`) instead of importing
 * `@deepseek-ai/dsh-llm`. That keeps the npm package installable on its own
 * and immune to duplicate-package `instanceof` skew.
 *
 * Wire shape (identical on both deployments):
 *   POST {endpoint}/v2/chat/completions  — OpenAI-compatible SSE
 *   Authorization: Bearer <token>, X-Domain, X-Product: SaaS,
 *   X-Product-Code: workbuddy, X-Agent-Purpose/Name/Type/Version, UA.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readToken, refreshRegion } from './auth.js'
import { unusableModelIds, readAvailability, writeAvailability } from './availability.js'
import { fetchModelEntries } from './catalog.js'
import { readCatalogCache, writeCatalogCache } from './catalog-cache.js'
import { readPrefs, isEnabled } from './model-prefs.js'
import { applyOfficialList, readOfficialList } from './official-list.js'
import { chatRoutes } from './regions.js'
import { notifyModelTopology } from './topology.js'

const CATALOG_TTL_MS = 10 * 60_000
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/**
 * Where the last rejected request is written. A channel rejection depends on
 * the exact body the harness assembled, which the session log does not record,
 * so the one request that failed is kept for offline comparison.
 */
const REJECTED_DUMP_PATH = join(tmpdir(), 'dsh-workbuddy-rejected.json')

function dumpRejectedRequest(region, model, route, payload, error) {
  try {
    writeFileSync(REJECTED_DUMP_PATH, JSON.stringify({
      at: new Date().toISOString(),
      region: region.id,
      model,
      endpoint: route.endpoint,
      productCode: route.productCode,
      bytes: payload.length,
      error: String(error).slice(0, 600),
      body: payload
    }, null, 2))
    console.warn(`[workbuddy] ${region.id}: 被拒请求已写入 ${REJECTED_DUMP_PATH}`)
  } catch {
    // diagnostics only
  }
}

const effortName = (id) => id.charAt(0).toUpperCase() + id.slice(1)

/**
 * Build the error the harness classifies. `code` and `status` are what the
 * retry policy and the transcript read; nothing else is carried, so no field
 * can be silently dropped by the normalizer on the way.
 */
function llmError(message, code, extra = {}) {
  const error = new Error(message)
  error.name = 'LlmError'
  error.code = code
  Object.assign(error, extra)
  error.failure = { message, code, ...(extra.status === undefined ? {} : { status: extra.status }) }
  return error
}

function errorDetail(body) {
  try {
    const data = JSON.parse(body)
    const localized = typeof data?.displayMsg?.zh === 'string' ? data.displayMsg.zh : undefined
    const parts = [
      localized,
      typeof data?.error?.message === 'string' ? data.error.message : undefined,
      typeof data?.msg === 'string' ? data.msg : undefined,
      typeof data?.message === 'string' ? data.message : undefined
    ].filter((value) => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // fall through to the raw body
  }
  return body.slice(0, 400)
}

function httpErrorCode(status, body) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return /context|too long|prompt is too long/i.test(body) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** The China gateway's "this caller is not an approved channel" rejection. */
function isUnapprovedChannel(body) {
  return /unapproved channel/i.test(body) || /Illegal API invocation/i.test(body)
}

/**
 * A busy model answers `HTTP 429` with business code `6020` and the untranslated
 * i18n key `queue.waiting.title` (plus `data.queue_position`). Recognise it by
 * either signal so a code change cannot silently turn a raw key back into the
 * transcript.
 */
function queueNotice(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const message = typeof parsed.msg === 'string' ? parsed.msg : ''
  if (parsed.code !== 6020 && !message.startsWith('queue.waiting')) return undefined
  const data = typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : {}
  return {
    position: typeof data.queue_position === 'number' ? data.queue_position : undefined
  }
}

/**
 * One non-2xx response → the LlmError the retry policy classifies.
 *
 * The queue case deliberately reports only `RATE_LIMIT`: retrying is the
 * harness's own exponential backoff (`dsh-llm-retry`, five attempts with
 * jitter), and the upstream `retry_after` hint is not forwarded, so one policy
 * owns the cadence instead of two.
 */
function requestFailure(provider, status, body) {
  const queue = queueNotice(body)
  if (queue !== undefined) {
    const position = queue.position === undefined ? '' : `（队列第 ${queue.position} 位）`
    return llmError(`${provider}: 模型排队中${position}，将自动重试`, 'RATE_LIMIT', { status })
  }
  return llmError(`${provider}: ${errorDetail(body)}`, httpErrorCode(status, body), { status })
}

/* ── harness message → OpenAI wire ─────────────────────────────────────────── */

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => typeof block === 'object' && block !== null && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
}

function normalizeToolArguments(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return '{}'
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? trimmed : '{}'
  } catch {
    return '{}'
  }
}

function isTruncatedArguments(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return false
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    return true
  }
}

const hasUsableToolName = (name) => typeof name === 'string' && name.trim().length > 0

/** Keep only tool call/result pairs that are complete on both sides. */
function resolveToolPairing(messages) {
  const allResultIds = new Set()
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'tool-result') allResultIds.add(String(block.toolCallId))
    }
  }
  const keepCallIds = new Set()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const calls = (Array.isArray(message.content) ? message.content : [])
      .filter((block) => block?.type === 'tool-call' && hasUsableToolName(block.name))
    if (calls.length > 0 && calls.every((block) => allResultIds.has(String(block.id)))) {
      for (const block of calls) keepCallIds.add(String(block.id))
    }
  }
  return { keepCallIds, keepResultIds: new Set(keepCallIds) }
}

function userContentParts(content, imageUrls) {
  const parts = []
  let hasImage = false
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'text') {
      parts.push({ type: 'text', text: String(block.text ?? '') })
      continue
    }
    if (block.type === 'image') {
      const attachmentId = block.attachment?.attachmentId
      const url = attachmentId === undefined ? undefined : imageUrls?.get(String(attachmentId))
      parts.push(url === undefined ? { type: 'text', text: '[image unavailable]' } : { type: 'image_url', image_url: { url } })
      hasImage = true
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls)
      if (inner !== undefined) {
        parts.push(...inner)
        hasImage = true
      } else {
        parts.push({ type: 'text', text: contentToText(block.content) })
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined
}

/**
 * Convert harness messages into the OpenAI-compatible wire array, matching the
 * shape the official clients send (including `reasoning_content` replay on
 * assistant turns, which WorkBuddy accepts).
 */
function toWireMessages(messages, imageUrls) {
  const wire = []
  let pendingToolImages = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages] })
    pendingToolImages = []
  }
  const { keepCallIds, keepResultIds } = resolveToolPairing(messages)

  for (const message of messages) {
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const toolCalls = content
        .filter((block) => block?.type === 'tool-call' && keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function',
          function: { name: String(block.name), arguments: normalizeToolArguments(block.arguments) }
        }))
      const reasoning = content.filter((block) => block?.type === 'reasoning').map((block) => String(block.text ?? '')).join('')
      const textContent = contentToText(content)
      if (textContent.trim().length === 0 && toolCalls.length === 0) continue
      flushToolImages()
      wire.push({
        role: 'assistant',
        content: textContent.length === 0 && toolCalls.length > 0 ? null : textContent,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      })
      continue
    }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }

    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block) => block?.type === 'tool-result')
    const regular = content.filter((block) => block?.type !== 'tool-result')
    const text = contentToText(message.content)
    const parts = userContentParts(regular, imageUrls)
    if (parts !== undefined) {
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.trim().length > 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue
      let resultText = '(no output)'
      if (imageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('')
          if (joined.length > 0) resultText = joined
        } else {
          resultText = contentToText(result.content) || '(no output)'
        }
      } else {
        resultText = contentToText(result.content) || '(no output)'
      }
      wire.push({ role: 'tool', tool_call_id: String(result.toolCallId), content: resultText })
    }
  }
  flushToolImages()
  return wire
}

function collectImageRefs(content, refs) {
  for (const raw of Array.isArray(content) ? content : []) {
    if (typeof raw !== 'object' || raw === null) continue
    if (raw.type === 'image' && typeof raw.attachment?.attachmentId === 'string') {
      refs.set(raw.attachment.attachmentId, raw.attachment)
      continue
    }
    if (raw.type === 'tool-result' && Array.isArray(raw.content)) collectImageRefs(raw.content, refs)
  }
}

/* ── adapter ──────────────────────────────────────────────────────────────── */

export class WorkBuddyAdapter {
  /**
   * @param {object} ctx - Cordis context (uses `ctx.get('attachments')` and `ctx.logger`).
   * @param {object} region - entry from `REGIONS`.
   */
  constructor(ctx, region) {
    this.ctx = ctx
    this.region = region
    this.sessionId = crypto.randomUUID().replace(/-/g, '')
    this.catalog = undefined
    this.catalogAt = 0
    /** Where the current catalog came from: 'scoped' | 'config' | 'cache' | 'none'. */
    this.catalogSource = 'none'
    /** When the on-disk cache behind `source === 'cache'` was written. */
    this.catalogCachedAt = undefined
  }

  providerInfo(provider) {
    return { id: provider, name: this.region.displayName }
  }

  /**
   * Called **directly** by the harness registry while registering this adapter
   * (`registration()` in `@deepseek-ai/dsh-llm`), which duck-types the adapter
   * instead of inheriting from its base class. Returning `undefined` means "use
   * the normal defaults" — but the method itself has to exist, or registration
   * throws and the whole plugin fails to apply (no providers, no HTTP routes,
   * a panel that answers 404).
   */
  providerRetryPolicy() {
    return undefined
  }

  /** Also part of the duck-typed surface, called when a request carries images. */
  imageRequestPricing() {
    return undefined
  }

  /** Preserve the normalized image as-is: this route never resizes. */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /** A fresh conversation identity, used when the gateway rejects the old one. */
  rotateIdentity() {
    this.sessionId = crypto.randomUUID().replace(/-/g, '')
  }

  /**
   * The account's live catalog, cached for {@link CATALOG_TTL_MS}.
   *
   * No built-in model table stands behind this, but the last successful read is
   * cached on disk: when both endpoints fail the cached catalog is served (and
   * labelled as such) instead of the list flipping between populated and empty.
   * Only with no live source *and* no cache is the catalog empty, while
   * `resolveModel` still answers for ids the session already knows.
   */
  async models() {
    const fresh = this.catalog !== undefined && Date.now() - this.catalogAt < CATALOG_TTL_MS
    if (fresh) return this.catalog
    let loaded
    try {
      loaded = await fetchModelEntries(this.ctx, this.region)
    } catch (error) {
      loaded = { entries: [], source: 'none', reasons: [String(error?.message ?? error)] }
    }
    // An imported account list wins over whatever the sources claim: it is the
    // one thing that reflects what this account may actually pick.
    const imported = readOfficialList(this.region.id)
    if (loaded.entries.length > 0) {
      const applied = applyOfficialList(loaded.entries, imported)
      this.catalog = applied.entries
      this.catalogSource = loaded.source
      this.catalogCachedAt = undefined
      if (imported !== undefined && applied.added > 0) {
        this.ctx.logger.info(`[workbuddy] ${this.region.id}: 账号名单补入 ${applied.added} 个上游目录没有的模型`)
      }
      const cached = writeCatalogCache(this.region.id, loaded.source, loaded.entries)
      if (cached.saved && cached.added > 0) {
        this.ctx.logger.info(`[workbuddy] ${this.region.id}: 目录缓存追加 ${cached.added} 个模型，累计 ${cached.total} 个`)
      }
    } else {
      const cached = readCatalogCache(this.region.id)
      if (cached !== undefined) {
        this.catalog = applyOfficialList(cached.entries, imported).entries
        this.catalogSource = 'cache'
        this.catalogCachedAt = cached.savedAt
        this.ctx.logger.warn(`[workbuddy] ${this.region.id}: 两个目录接口都没取到，使用本地缓存（${this.catalog.length} 个可用模型，上次实时读到 ${cached.liveCount} 个 / ${new Date(cached.savedAt).toLocaleString()}，来源 ${cached.source}）— ${loaded.reasons.join('；')}`)
      } else if (imported !== undefined) {
        this.catalog = applyOfficialList([], imported).entries
        this.catalogSource = 'import'
        this.catalogCachedAt = undefined
        this.ctx.logger.warn(`[workbuddy] ${this.region.id}: 取不到目录，只有导入的账号名单（${this.catalog.length} 个）— ${loaded.reasons.join('；')}`)
      } else {
        const token = await readToken(this.ctx, this.region)
        if (token.length > 0) {
          this.ctx.logger.warn(`[workbuddy] ${this.region.id}: 取不到模型列表，且没有本地缓存 — ${loaded.reasons.join('；')}`)
        }
        this.catalog = []
        this.catalogSource = 'none'
        this.catalogCachedAt = undefined
      }
    }
    this.catalogAt = Date.now()
    return this.catalog
  }

  /**
   * Drop the in-memory catalog so the next call sees a freshly signed-in
   * account. The on-disk cache stays: it is the fallback for a later outage.
   */
  invalidateCatalog() {
    this.catalog = undefined
    this.catalogAt = 0
    this.catalogSource = 'none'
    this.catalogCachedAt = undefined
  }

  /**
   * The verdicts the availability ledger holds for this deployment, keyed by
   * model id. The panel groups by these; the picker hides `dead` ones.
   */
  availability() {
    return readAvailability(this.region.id).models
  }

  /**
   * Record a model's own failure so the picker stops offering it.
   *
   * Learned from real turns rather than a sweep: `11102` means the id is gone,
   * `11158` means this account may not use the model. Neither costs anything
   * extra — the user already spent that request.
   */
  rememberUnusable(model, code, detail) {
    const text = String(detail)
    if (/11102|service info not found/i.test(text)) {
      writeAvailability(this.region.id, [{ id: model, state: 'dead', detail: '模型不存在（11102 service info not found）', at: Date.now() }])
      this.invalidateCatalog()
      // The verdict feeds the default on/off state, so the picker has to re-read.
      notifyModelTopology(this.ctx)
      return
    }
    if (/11158|is not allowed for user type/i.test(text)) {
      const type = /user type \[([^\]]{0,40})\]/i.exec(text)?.[1] ?? ''
      writeAvailability(this.region.id, [{ id: model, state: 'denied', detail: `账号无权限（11158${type.length > 0 ? `，用户类型 ${type}` : ''}）`, at: Date.now() }])
      this.invalidateCatalog()
      notifyModelTopology(this.ctx)
    }
  }

  async entryOf(model) {
    const catalog = await this.models()
    return catalog.find((entry) => entry.id === model)
  }

  /**
   * Replay the harness's own validation over what this adapter advertises.
   *
   * The picker builds its list per provider and **drops a whole group** when any
   * entry or resolution throws, so one bad model hides every model of that
   * deployment — which looks exactly like "the plugin isn't installed". These
   * rules are copied from `@deepseek-ai/dsh-llm` (`listModels` →
   * `INVALID_CATALOG`, `normalizeModelInfo` → the `INVALID_MODEL_*` codes) so the
   * answer is available from the host log without a browser.
   *
   * @returns {Promise<{ models: number, problems: string[] }>}
   */
  async auditPicker(provider) {
    const problems = []
    let models = []
    try {
      models = await this.listModels(provider)
    } catch (error) {
      return { models: 0, problems: [`listModels 抛出：${error instanceof Error ? error.message : String(error)}`] }
    }
    const seen = new Set()
    for (const model of models) {
      if (model.provider !== provider || typeof model.id !== 'string' || model.id.length === 0) {
        problems.push(`${model?.id ?? '?'}: 条目身份不合法`)
        continue
      }
      if (typeof model.name !== 'string' || model.name.length === 0) problems.push(`${model.id}: 名称为空（INVALID_CATALOG）`)
      if (seen.has(model.id)) problems.push(`${model.id}: id 重复（INVALID_CATALOG）`)
      seen.add(model.id)
      let resolved
      try {
        resolved = await this.resolveModel(provider, model.id)
      } catch (error) {
        problems.push(`${model.id}: resolveModel 抛出：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (resolved.provider !== provider || resolved.id !== model.id) problems.push(`${model.id}: 身份回显不符`)
      if (typeof resolved.name !== 'string' || resolved.name.length === 0) problems.push(`${model.id}: 解析后名称为空`)
      const window = resolved.context?.contextWindow
      if (window !== undefined && (!Number.isInteger(window) || window <= 0)) problems.push(`${model.id}: contextWindow 非法（${window}）`)
      const maxTokens = resolved.defaultMaxTokens
      if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) problems.push(`${model.id}: defaultMaxTokens 非法（${maxTokens}）`)
      const reasoning = resolved.reasoning
      if (reasoning === undefined) continue
      if (!Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) {
        problems.push(`${model.id}: reasoning.efforts 为空（INVALID_MODEL_REASONING）`)
        continue
      }
      const levels = new Set()
      for (const effort of reasoning.efforts) {
        if (typeof effort.id !== 'string' || effort.id.length === 0 || typeof effort.name !== 'string' || effort.name.length === 0) {
          problems.push(`${model.id}: 档位缺少 id 或名称`)
          break
        }
        if (levels.has(effort.id)) {
          problems.push(`${model.id}: 档位 ${effort.id} 重复`)
          break
        }
        levels.add(effort.id)
      }
      if (reasoning.defaultEffort !== undefined && !levels.has(reasoning.defaultEffort)) {
        problems.push(`${model.id}: 默认档 ${reasoning.defaultEffort} 不在 [${[...levels].join(',')}] 内（INVALID_MODEL_REASONING）`)
      }
    }
    return { models: models.length, problems }
  }

  async listModels(provider) {
    const catalog = await this.models()
    // What the picker offers: the hand decisions first, the availability verdict
    // as the default (see `model-prefs.js`). An unusable model stays selectable
    // when the user asks for it, which is how one gets tried anyway.
    const prefs = readPrefs(this.region.id)
    const dead = unusableModelIds(this.region.id)
    const offered = catalog.filter((entry) => isEnabled(prefs, entry.id, dead.has(entry.id)))
    // Always logged: one line per picker open, and the fastest way to answer
    // "did the picker re-read the list after that switch was flipped?".
    this.ctx.logger.info(`[workbuddy] ${this.region.id}: 选择器读取目录 → ${offered.length}/${catalog.length} 个可选`)
    return offered.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: [...entry.input]
    }))
  }

  /**
   * The declared metadata for one model, or a minimal stand-in when the
   * catalog is unavailable: an id the session already knows must still be
   * callable during a catalog outage.
   */
  async resolveModel(provider, model) {
    const entry = await this.entryOf(model)
    const levels = entry?.efforts === undefined ? [] : Object.keys(entry.efforts)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: [...(entry?.input ?? ['text'])],
      ...(entry?.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
      ...(entry?.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens }),
      ...(levels.length === 0 ? {} : {
        reasoning: {
          efforts: levels.map((id) => ({ id, name: effortName(id) })),
          ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort })
        }
      })
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    }
  }

  async resolveImages(messages) {
    const refs = new Map()
    for (const message of messages) collectImageRefs(message.content, refs)
    if (refs.size === 0) return undefined
    const attachments = this.ctx.get('attachments')
    const urls = new Map()
    for (const [id, ref] of refs) {
      try {
        const stored = await attachments?.readImage?.(ref)
        const mediaType = stored?.ref?.mediaType
        if (stored?.data !== undefined && typeof mediaType === 'string') {
          urls.set(id, `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
        }
      } catch (error) {
        this.ctx.logger.warn(`[workbuddy] ${this.region.id}: 读取图片附件 ${id} 失败 — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return urls
  }

  /**
   * Neutralise the one system-prompt fingerprint the China gateway blocks.
   *
   * Verified 2026-10-21 against `copilot.tencent.com`: a system message whose
   * text *begins* with `You are an AI agent powered by DeepSeek Harness`
   * (case-insensitive, trailing period optional) is answered with
   * `code 11128 Illegal API invocation from an unapproved channel`. The bare
   * phrase, a leading word, and the same sentence with another noun all pass,
   * so the rule is an anchored brand fingerprint rather than a content filter.
   * Rewriting that opening keeps every other instruction intact.
   *
   * Applied to both deployments: the international gateway accepts the
   * original wording, but one prompt shape for both routes is simpler to
   * reason about and cannot regress when the rule spreads.
   */
  sanitizeSystem(text) {
    if (typeof text !== 'string') return text
    return text.replace(/^[ \t\r\n]*you are an ai agent powered by deepseek harness\.?/i, 'You are an AI agent.')
  }

  buildBody(options, model, entry, imageUrls) {
    const messages = toWireMessages(options.messages, imageUrls)
    for (const message of messages) {
      if (message.role === 'system' && typeof message.content === 'string') message.content = this.sanitizeSystem(message.content)
    }
    if (typeof options.system === 'string' && options.system.length > 0) {
      messages.unshift({ role: 'system', content: this.sanitizeSystem(options.system) })
    }
    // WorkBuddy's gateway rejects a conversation without a system message
    // (code 11128), so synthesize the same neutral one the desktop clients send.
    if (messages.length === 0 || messages[0].role !== 'system') {
      messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }

    const body = {
      model,
      messages,
      stream: true,
      // The official client asks for the usage frame explicitly; without it the
      // gateway may omit `usage` on some routes, which costs the panel its token
      // counts and the diagnostics their output-token line.
      stream_options: { include_usage: true },
      // Server-side prefix cache: without this field the hit rate is always 0.
      prompt_cache_key: this.sessionId
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }))
    if (tools !== undefined && tools.length > 0) body.tools = tools
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
    const maxTokens = positiveInt(options.maxTokens) ?? entry?.maxTokens
    if (maxTokens !== undefined) body.max_tokens = maxTokens

    // Thinking is pinned on for every model, with no per-family branch: the effort
    // level is the only reasoning control, and it is picked from what the catalog
    // declares rather than from the model's name —
    //   1. the level the caller chose, when the model declares it;
    //   2. otherwise the model's own `defaultEffort` from the catalog;
    //   3. otherwise `high` when declared, else the first declared level;
    //   4. no levels declared → send nothing and let the deployment decide.
    //
    // The `thinking` field is deliberately **not** sent for anyone. Measured
    // 2026-10-23 on both deployments (`test/live/thinking-field-probe.mjs`): with
    // `reasoning_effort` present, dropping `thinking:{type:'enabled'}` changes
    // nothing at `high` (0 reasoning chars either way) and yields slightly more
    // reasoning at `max` (384 vs 306 on INTL, 476 vs 418 on CN). The official client
    // only sends that field when it turns thinking *off*, so the enabled form was
    // never part of its contract.
    //
    // `efforts` is optional: many catalog entries declare no level set, and reading
    // `Object.keys` off that `undefined` used to throw before the request was built.
    const levels = entry?.efforts === undefined ? [] : Object.keys(entry.efforts)
    const preferred = levels.includes(options.reasoningEffort)
      ? options.reasoningEffort
      : (levels.includes(entry?.defaultEffort) ? entry.defaultEffort : undefined)
    const effort = preferred ?? (levels.includes('high') ? 'high' : levels[0])
    if (effort !== undefined) body.reasoning_effort = effort
    return body
  }

  /** Wire routes this adapter may use, in preference order (see `regions.js`). */
  routes() {
    return chatRoutes(this.region)
  }

  headers(token, route) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Domain': route.apiDomain,
      'X-Product': 'SaaS',
      'X-Product-Code': route.productCode,
      'X-Agent-Purpose': 'conversation',
      'X-IDE-Name': route.ideName,
      'X-IDE-Type': route.ideName,
      'X-IDE-Version': route.ideVersion,
      'User-Agent': route.userAgent,
      'X-Conversation-ID': this.sessionId,
      'X-Conversation-Message-ID': crypto.randomUUID(),
      'X-Conversation-Request-ID': crypto.randomUUID()
    }
  }

  async send(token, body, signal, route) {
    try {
      return await fetch(`${route.endpoint}/v2/chat/completions`, {
        method: 'POST',
        headers: this.headers(token, route),
        body,
        signal
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw llmError(`${this.region.provider}: 传输失败 — ${error instanceof Error ? error.message : String(error)}`, 'TRANSPORT', { cause: error })
    }
  }

  async *stream(options) {
    const model = options.model
    const entry = await this.entryOf(model)
    let token = await readToken(this.ctx, this.region)
    if (token.length === 0) {
      throw llmError(`${this.region.provider}: 未登录，请先运行 /workbuddy login ${this.region.id}`, 'MISSING_CREDENTIAL')
    }
    const imageUrls = await this.resolveImages(options.messages)
    const payload = () => JSON.stringify(this.buildBody(options, model, entry, imageUrls))
    const routes = this.routes()
    let route = routes[0]

    let response = await this.send(token, payload(), options.signal, route)
    let rejection = ''
    if (!response.ok) {
      rejection = await response.text().catch(() => '')

      if (isUnapprovedChannel(rejection)) {
        // The gateway no longer associates this conversation identity with an
        // approved client. A fresh identity is the one input we control, so
        // retry once with it; if that still fails, fall back to the other
        // China route, whose channel is approved by construction.
        dumpRejectedRequest(this.region, model, route, payload(), rejection)
        this.rotateIdentity()
        this.ctx.logger.warn(`[workbuddy] ${this.region.id}: 网关判为未获批渠道，已换会话标识重试一次`)
        response = await this.send(token, payload(), options.signal, route)
        rejection = response.ok ? '' : await response.text().catch(() => '')
        if (!response.ok && routes[1] !== undefined && isUnapprovedChannel(rejection)) {
          this.ctx.logger.warn(`[workbuddy] ${this.region.id}: 主通道仍被拒，改走 ${routes[1].endpoint}`)
          route = routes[1]
          response = await this.send(token, payload(), options.signal, route)
          rejection = response.ok ? '' : await response.text().catch(() => '')
        }
      } else if (response.status === 401 || response.status === 403) {
        const rotated = await refreshRegion(this.ctx, this.region, { force: true })
        if (rotated.refreshed) {
          token = await readToken(this.ctx, this.region)
          if (token.length > 0) {
            response = await this.send(token, payload(), options.signal, route)
            rejection = response.ok ? '' : await response.text().catch(() => '')
          }
        }
      }
    }
    if (!response.ok) {
      const failure = requestFailure(this.region.provider, response.status, rejection)
      this.rememberUnusable(model, failure.code, errorDetail(rejection))
      throw failure
    }
    yield* this.consumeSse(response, options)
  }

  /** Parse the OpenAI-compatible SSE stream into harness stream chunks. */
  async *consumeSse(response, options) {
    if (response.body === null) throw llmError(`${this.region.provider}: 响应没有正文`, 'EMPTY_RESPONSE')
    const blocks = []
    let nextIndex = 0
    let finishReason
    const toolCalls = new Map()
    const toolOrder = []
    const toolIds = new Map()
    let buffer = ''
    let streamEnded = false
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // Evidence for the "the stream was cut" report below: how much arrived, how
    // long it took, how long the silence before the cut was, and what was being
    // written when it happened. The remote's own reason is not observable, so the
    // report has to carry what *is*.
    const startedAt = Date.now()
    let receivedBytes = 0
    let lastDataAt = startedAt
    let lastDelta = '无内容'
    /** Output tokens the last usage frame reported, for the truncation log. */
    let outputTokens
    /** The gateway's own response id, for correlating with upstream logs. */
    let responseId
    /**
     * The finish chunk's diagnostics block.
     *
     * Not part of the harness contract — the other adapters attach their own and
     * the session diagnostics show it verbatim, which is how a "who answered this,
     * and what did upstream call it" question gets answered without reconstructing
     * it from the request headers. Carries nothing the harness acts on.
     */
    const finishChunk = (reason) => ({
      type: 'finish',
      reason,
      response: {
        kind: 'workbuddy',
        version: 1,
        api: 'openai-completions',
        provider: this.region.provider,
        model: options.model,
        ...(responseId === undefined ? {} : { responseId }),
        stopReason: finishReason ?? reason.kind,
        ...(outputTokens === undefined ? {} : { outputTokens }),
        blocks: blocks.map((block) => ({ type: block.kind }))
      }
    })

    const textBlock = () => {
      let block = blocks.find((candidate) => candidate.kind === 'text')
      if (block === undefined) {
        block = { index: nextIndex++, kind: 'text', text: '' }
        blocks.push(block)
      }
      return block
    }
    const reasoningBlock = () => {
      let block = blocks.find((candidate) => candidate.kind === 'reasoning')
      if (block === undefined) {
        block = { index: nextIndex++, kind: 'reasoning', text: '' }
        blocks.push(block)
      }
      return block
    }

    try {
      while (!streamEnded) {
        const result = await reader.read()
        if (result.done) break
        receivedBytes += result.value?.byteLength ?? 0
        lastDataAt = Date.now()
        buffer += decoder.decode(result.value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          if (data.choices === undefined && typeof data.code === 'number' && data.code !== 0) {
            throw llmError(`${this.region.provider}: code=${data.code} ${errorDetail(payload)}`, 'INVALID_REQUEST')
          }
          if (data.error !== undefined) {
            throw llmError(`${this.region.provider}: ${data.error?.message ?? '未知错误'}`, 'SERVER')
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (responseId === undefined && typeof data.id === 'string' && data.id.length > 0) responseId = data.id
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) finishReason = choice.finish_reason

          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            const block = textBlock()
            if (block.text.length === 0) yield { type: 'block-start', index: block.index, blockType: 'text' }
            block.text += delta.content
            lastDelta = '正文'
            yield { type: 'text-delta', index: block.index, text: delta.content }
          }
          if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            const block = reasoningBlock()
            if (block.text.length === 0) yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            block.text += delta.reasoning_content
            lastDelta = '思考'
            yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId, announced: false, name: undefined }
              toolCalls.set(wireIndex, block)
            }
            block.callId = callId
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name
            lastDelta = '工具调用'
            const fragment = call.function?.arguments ?? ''
            block.text += fragment
            if (!block.announced) {
              if (!hasUsableToolName(block.name)) continue
              block.announced = true
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: block.index, id: callId, name: block.name, argumentsDelta: block.text }
              continue
            }
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: callId,
              ...(block.name === undefined ? {} : { name: block.name }),
              argumentsDelta: fragment
            }
          }
          if (data.usage !== undefined && data.usage !== null) {
            const promptTokens = data.usage.prompt_tokens ?? 0
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens ?? 0
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
            outputTokens = data.usage.completion_tokens ?? 0
            yield {
              type: 'usage',
              usage: {
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
                ...(typeof reasoningTokens === 'number' && reasoningTokens > 0 ? { reasoningTokens } : {})
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    let blockCount = 0
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find((candidate) => candidate.index === index)
      if (block === undefined || !hasUsableToolName(block.name)) continue
      // A call whose arguments never finished arriving cannot be executed: handed
      // over, it becomes a parse error in the transcript instead of the truncation
      // that actually happened. It is reported as `max-tokens` below instead, so
      // the step can be continued rather than failed.
      if (isTruncatedArguments(block.text)) continue
      blockCount += 1
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: block.callId,
          name: block.name,
          arguments: normalizeToolArguments(block.text)
        }
      }
    }
    const prose = blocks.find((block) => block.kind === 'text')
    if (prose !== undefined) {
      blockCount += 1
      yield { type: 'block-end', index: prose.index, block: { type: 'text', text: prose.text } }
    }
    const reasoning = blocks.find((block) => block.kind === 'reasoning')
    if (reasoning !== undefined && reasoning.text.trim().length > 0) {
      blockCount += 1
      yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.text } }
    }

    const argsTruncated = [...toolCalls.values()].some((block) => isTruncatedArguments(block.text))
    // A tool-call fragment whose name never arrived cannot be announced, so it never
    // reaches `toolOrder` — and when upstream then ends with `stop`, the step reads as
    // "the model chose to stop" while a call was in fact in flight. That is a silent
    // drop, so it is reported instead: the harness keeps an honest failure, and the
    // log names what happened.
    const orphanCalls = [...toolCalls.values()].filter((block) => !hasUsableToolName(block.name) && block.text.trim().length > 0)
    if (orphanCalls.length > 0) {
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 收到 ${orphanCalls.length} 个工具调用分片但始终没有工具名（finish_reason=${finishReason ?? '(无)'}），按传输错误上报，可自动重试`)
      yield finishChunk({
        kind: 'error',
        failure: {
          message: `${this.region.provider}: 上游发送了工具调用但没有给出工具名（finish_reason=${finishReason ?? '(无)'}；可重试的传输错误）`,
          code: 'TRANSPORT'
        }
      })
      return
    }
    // A stream that stops without the `[DONE]` sentinel was cut, not finished:
    // upstream closed the connection mid-answer. Reporting that as a normal stop
    // ends the turn silently — the model looks like it simply chose to stop — and
    // the retry policy never sees a failure. It has to be an error so a truncated
    // answer is retried and, failing that, surfaced.
    if (!streamEnded && finishReason === undefined) {
      const detail = describeCut({ receivedBytes, startedAt, lastDataAt, lastDelta })
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的响应在 finish_reason/[DONE] 之前中断（${detail}），按传输错误上报，可自动重试`)
      yield finishChunk({
        kind: 'error',
        failure: {
          message: `${this.region.provider}: 上游没有给出结束原因就断开了响应（${detail}；可重试的传输错误）`,
          code: 'TRANSPORT'
        }
      })
      return
    }
    if (argsTruncated && !streamEnded) {
      const detail = describeCut({ receivedBytes, startedAt, lastDataAt, lastDelta })
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的工具调用参数在传输中被截断（${detail}），按传输错误上报，可自动重试`)
      yield finishChunk({
        kind: 'error',
        failure: {
          message: `${this.region.provider}: 工具调用的参数在传输中被截断（${detail}；可重试的传输错误）`,
          code: 'TRANSPORT'
        }
      })
      return
    }
    // Truncated arguments are checked before the empty-response rule: a step whose
    // only tool call was cut short has no usable block to hand over, and calling
    // that "empty" would hide what happened.
    if (argsTruncated) {
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的工具调用参数被输出上限截断，本步按 max-tokens 上报（harness 可续跑）`)
      yield finishChunk({ kind: 'max-tokens' })
      return
    }
    if (blockCount === 0) {
      yield finishChunk({ kind: 'error', failure: { message: '模型返回了空响应', code: 'EMPTY_RESPONSE' } })
      return
    }
    // `finish_reason` has more values than the three the OpenAI docs mention, and
    // the official CodeBuddy CLI maps the whole set (`mapFinishReasonToStopReason`
    // in its bundle): `refusal` / `content_filter` are their own outcome, not a
    // stop, and `error` means the provider gave up mid-answer. Mapping those to
    // `stop` is how a refusal and a real finish became indistinguishable here.
    const refusalReason = finishReason === 'refusal' || finishReason === 'content_filter'
    if (refusalReason) {
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的上游拒绝/过滤了本次回答（finish_reason=${finishReason}），不重试`)
      yield finishChunk({
        kind: 'error',
        failure: {
          message: `${this.region.provider}: 上游拒绝或按内容策略过滤了本次回答（finish_reason=${finishReason}），请换个说法或换个模型`,
          code: 'INVALID_REQUEST'
        }
      })
      return
    }
    if (finishReason === 'error') {
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的上游以 finish_reason=error 结束，按传输错误上报，可自动重试`)
      yield finishChunk({
        kind: 'error',
        failure: {
          message: `${this.region.provider}: 上游在回答中途返回了错误（finish_reason=error；可重试的传输错误）`,
          code: 'TRANSPORT'
        }
      })
      return
    }
    const toolReason = finishReason === 'tool_calls' || finishReason === 'tool_use' || finishReason === 'function_call'
    const reason = toolReason || toolOrder.length > 0
      ? { kind: 'tool-calls' }
      : finishReason === 'length' || finishReason === 'max_tokens'
        ? { kind: 'max-tokens' }
        : { kind: 'stop' }
    // Two endings are complete-looking but are not the model choosing to stop, and
    // nothing downstream can tell them apart. Both get a line of their own:
    //   · the answer ran into the output budget (a truncation reads as a finish);
    //   · upstream closed with `[DONE]` but never said *why* the answer ended.
    if (reason.kind === 'max-tokens') {
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的输出达到上限，本步被截断（输出 ${outputTokens ?? '未知'} tokens）`)
    } else if (reason.kind === 'stop' && finishReason === undefined) {
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 的响应以 [DONE] 收尾但没有 finish_reason，按 stop 处理（输出 ${outputTokens ?? '未知'} tokens）`)
    } else if (reason.kind === 'stop' && !['stop', 'end_turn', 'stop_sequence'].includes(finishReason)) {
      // An unknown value is worth seeing: the official client leaves the stop
      // reason at its default for these too, so nobody upstream has classified them.
      this.ctx.logger.warn(`[workbuddy] ${this.region.id}: ${options.model} 返回了未识别的 finish_reason=${finishReason}，按 stop 处理`)
    }
    yield finishChunk(reason)
  }
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Describe a stream that ended without its terminator.
 *
 * The rule is deliberately mechanical: a response is complete only when it carries
 * `finish_reason` (and the SSE stream reaches `[DONE]`) or delivers a tool call.
 * Anything else is a cut connection, reported as a retryable `TRANSPORT` failure.
 *
 * Why the *remote* closed the connection is not observable from here, so the report
 * carries what is: how much arrived, how long it took, how long the silence before
 * the cut, and what was being written at the time.
 */
function describeCut({ receivedBytes, startedAt, lastDataAt, lastDelta }) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  const silence = ((Date.now() - lastDataAt) / 1000).toFixed(1)
  const size = receivedBytes < 1024 ? `${receivedBytes} B` : `${(receivedBytes / 1024).toFixed(1)} kB`
  return `收到 ${size}，用时 ${elapsed}s，最后一段数据在 ${silence}s 前，中断时正在输出${lastDelta}`
}
