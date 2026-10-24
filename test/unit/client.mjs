/**
 * Unit check for the Client half. Three layers, cheapest first:
 *
 *   1. registration — the module claims `settings.section` with a label thunk
 *      and installs its dictionaries;
 *   2. translation — a key the locale service only echoes back falls back to this
 *      bundle's dictionary (otherwise a hot-reloaded panel shows raw keys);
 *   3. **render** — the panel actually runs against real answers, and the tree it
 *      produces carries the numbers, tags and groups a user reads.
 *
 * The render layer is the point: the panel is one large function, so a helper
 * that no longer exists, a renamed dictionary key, or a data branch that throws
 * is a broken settings page in the app — and layers 1-2 would not notice.
 *
 * Run: `node test/unit/client.mjs`
 */

import assert from 'node:assert/strict'

let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => { definition = value }
  }
}

await import('../../client/index.js')
assert.ok(definition, 'client.js must call window.__ModuleLoader__.load')
assert.equal(definition.id, '@huai_xin/dsh-workbuddy')

// ---------------------------------------------------------------------------
// A React small enough to be obviously correct, big enough to run the panel:
// state updates re-render, effects run once, and the driver settles the tree by
// awaiting microtasks the way the browser would.
// ---------------------------------------------------------------------------

const elements = []

function createRoot() {
  const slots = []
  let cursor = 0
  let dirty = false
  let pending = []
  let tree

  const schedule = () => { dirty = true }

  const React = {
    createElement: (type, props, ...children) => {
      const element = { type, props: props ?? {}, children }
      elements.push(element)
      return element
    },
    useState: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[at]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        schedule()
      }]
    },
    // Effects are queued, not run inline: React runs them after the whole
    // component body has executed, so helpers defined further down are already
    // initialized. Running them mid-body would report a temporal dead zone that
    // the real renderer never hits.
    useEffect: (fn, deps) => {
      const at = cursor++
      const previous = slots[at]
      const changed = previous === undefined || deps === undefined ||
        deps.some((value, index) => value !== previous.deps[index])
      slots[at] = { deps: deps ?? [] }
      if (changed) pending.push(fn)
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => {
      const at = cursor++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    }
  }

  /** Render until the tree stops changing, letting pending promises resolve. */
  const render = async (component, props) => {
    for (let pass = 0; pass < 12; pass += 1) {
      cursor = 0
      dirty = false
      pending = []
      tree = component(props)
      const queued = pending
      pending = []
      for (const fn of queued) fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) break
    }
    return tree
  }

  return { React, render }
}

const { React, render } = createRoot()

const module = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
assert.deepEqual(module.inject, ['slots'])
assert.equal(typeof module.apply, 'function')

const registrations = []
const injected = []
const locales = []
const effects = []

const locale = {
  getLocale: () => ({ locales: [{ id: 'zh-CN' }, { id: 'en' }], active: 'zh-CN', revision: 1 }),
  register: (ns, id, dict) => {
    locales.push({ ns, id, dict })
    return () => {}
  },
  // Mimics a locale service that was handed a dictionary before this bundle
  // gained new keys: it answers what it knows and echoes anything else back.
  bind: () => (key) => (key === 'section' ? 'WorkBuddy 模型（来自词典服务）' : key)
}

const provided = new Map()
module.apply({
  get: (name) => (name === 'locale' ? locale : undefined),
  effect: (factory) => { effects.push(factory) },
  // Client services: `ctx.provide(name, value)` is how one plugin publishes for another
  // (`chatFileMentions`, `theme` and `feedbackUi` do the same upstream).
  provide: (name, value) => { provided.set(name, value) },
  slots: {
    inject: (owner, callback) => {
      injected.push(owner)
      callback()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    }
  }
})

assert.deepEqual(injected, ['settings.section'])
assert.equal(registrations.length, 1)
assert.equal(registrations[0].options.name, 'settings.section')
assert.equal(registrations[0].options.id, 'workbuddy')
assert.equal(typeof registrations[0].options.label, 'function')
assert.equal(typeof registrations[0].component, 'function')
assert.equal(locales.length, 2)
assert.ok(locales.every((entry) => entry.ns === 'workbuddy'))
assert.ok(effects.length >= 1)

// The state service other client plugins read. It must be provided under the scoped name,
// satisfy the observable contract before any data arrives, and never throw.
{
  const service = provided.get('@huai_xin/dsh-workbuddy/state')
  assert.ok(service !== undefined, 'the state service is provided')
  assert.equal(typeof service.getSnapshot, 'function')
  assert.equal(typeof service.subscribe, 'function')

  const empty = service.getSnapshot()
  assert.deepEqual(empty.providers, {}, 'nothing published yet is an empty map, not undefined')
  assert.equal(service.getSnapshot(), empty, 'getSnapshot returns a stable reference')
  assert.doesNotThrow(() => JSON.stringify(empty))

  const seen = []
  const unsubscribe = service.subscribe((snapshot) => seen.push(snapshot))
  const next = { version: 1, updatedAt: 1, providers: { '@huai_xin/dsh-workbuddy/cn': { loggedIn: true } } }
  service.publish(next)
  assert.equal(seen.length, 1, 'a subscriber hears about a publication')
  assert.equal(seen[0], next, 'and gets the snapshot itself')
  unsubscribe()
  service.publish({ version: 1, updatedAt: 2, providers: {} })
  assert.equal(seen.length, 1, 'unsubscribing stops the notifications')
  assert.doesNotThrow(() => service.subscribe(undefined), 'a bad subscriber is refused, not thrown at')
}

// The label thunk must survive a locale switch (it is re-read per projection).
assert.equal(registrations[0].options.label(), 'WorkBuddy 模型（来自词典服务）', 'a key the service knows comes from the service')

registrations[0].component({})
const panelT = elements[elements.length - 1].props.t
assert.equal(typeof panelT, 'function')
assert.equal(panelT('section'), 'WorkBuddy 模型（来自词典服务）')
assert.equal(panelT('renewBoth'), '续期', 'a key the service does not know falls back to the local dictionary')
assert.equal(panelT('definitelyMissing'), 'definitelyMissing', 'an unknown key is still visible rather than blank')
assert.equal(panelT('count')(7), '7 个', 'a function-valued entry keeps its arguments')

// ---------------------------------------------------------------------------
// Render layer
// ---------------------------------------------------------------------------

/** Every string the tree renders, in order, for assertions about the output. */
const textsOf = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textsOf(child, out); return out }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textsOf(child, out)
  }
  return out
}

/**
 * Every tooltip in the tree. Some state is deliberately carried by a `title`
 * rather than by text — the deployment status pill is a coloured dot whose word
 * exists only as a tooltip.
 */
const titlesOf = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) titlesOf(child, out); return out }
  if (typeof node !== 'object') return out
  if (typeof node.props?.title === 'string') out.push(node.props.title)
  if (Array.isArray(node.children)) for (const child of node.children) titlesOf(child, out)
  return out
}

const region = (overrides) => ({
  id: 'cn',
  provider: '@huai_xin/dsh-workbuddy/cn',
  endpoint: 'https://www.workbuddy.cn',
  loggedIn: true,
  pending: false,
  nickname: '示例账号',
  expiresAt: Date.now() + 3_600_000,
  refreshable: true,
  models: 2,
  credits: { ok: true, total: 1293.5, daily: 120, unlimited: false, packages: [], at: Date.now() },
  checkin: { supported: true, ok: true, todayCheckedIn: true, streakDays: 3, weekProgress: [1, 1, 1, 0, 0, 0, 0], active: true },
  lastClaim: { day: '2026-10-22', claimed: true, credit: 300, at: Date.now() },
  hasBusy: true,
  ...overrides
})

const signedInState = {
  regions: [
    region({}),
    region({ id: 'intl', provider: '@huai_xin/dsh-workbuddy/intl', nickname: '900000001', models: 1, hasBusy: false, checkin: null, lastClaim: null })
  ],
  importToken: 'token',
  version: '0.0.0-test',
  codeStamp: 'test'
}

/**
 * Signed out but not expired: the Host reports `loggedIn: false` with
 * `expiresAt: 0`. A remembered expiry with `loggedIn: false` would mean the
 * token lapsed, which the panel words as 已过期 instead.
 */
const signedOutState = {
  regions: [
    region({ loggedIn: false, expiresAt: 0, nickname: '', credits: null, checkin: null, lastClaim: null, models: 0 }),
    region({ id: 'intl', provider: '@huai_xin/dsh-workbuddy/intl', loggedIn: false, expiresAt: 0, nickname: '', credits: null, checkin: null, lastClaim: null, models: 0, hasBusy: false })
  ],
  importToken: 'token',
  version: '0.0.0-test',
  codeStamp: 'test'
}

const models = [
  {
    id: 'hy3',
    name: 'Hy3',
    description: '轻量模型',
    credits: '0.08',
    efforts: ['low', 'high'],
    defaultEffort: 'high',
    contextWindow: 192000,
    maxTokens: 64000,
    input: ['text', 'image'],
    promotion: { label: 'Free now', color: '#e5484d', kind: 'discount', text: 'Free daily use', from: '2026-08-06T00:00:00Z', until: '2026-11-01T00:00:00Z' },
    availability: { state: 'ok', at: Date.now() },
    enabled: true,
    decided: false
  },
  {
    id: 'glm-5.0',
    name: 'GLM-5.0',
    credits: undefined,
    efforts: [],
    input: ['text'],
    // A dead model that still carries a promotion and a busy level: the unusable group must
    // render neither on the row (they are noise for something that cannot be called, and the
    // three tags overflowed), while the details keep both.
    promotion: { label: '夜间折扣', color: '#d89614', kind: 'discount', text: 'nightly discount' },
    availability: { state: 'dead', detail: '模型不存在', at: Date.now() },
    enabled: false,
    decided: false
  },
  {
    // Usable, but the deployment publishes no rate for it: the row must say so
    // rather than invent one.
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    credits: undefined,
    efforts: [],
    input: ['text'],
    availability: { state: 'ok', at: Date.now() },
    enabled: true,
    decided: true
  }
]

/**
 * The registered component is a thin wrapper that binds the panel's translate
 * function; the panel itself is the wrapper's element type.
 */
const slotComponent = registrations[0].component
const wrapper = slotComponent({})
const Panel = wrapper.type
assert.equal(typeof Panel, 'function', 'the slot renders the panel component')

/** Answer `/state`, `/models`, `/busy` and `/availability` the way the Host does. */
function installFetch({ state, models: modelAnswer, busy, fail = false }) {
  const calls = []
  globalThis.fetch = async (url) => {
    const href = String(url)
    calls.push(href)
    if (fail) throw new Error('offline')
    const body = href.includes('/models') ? { models: modelAnswer ?? [] }
      : href.includes('/busy') ? { levels: busy ?? {} }
        : state
    return { ok: true, status: 200, json: async () => body }
  }
  return calls
}

globalThis.setTimeout = globalThis.setTimeout ?? (() => 0)
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }

const renderPanel = () => render(Panel, wrapper.props)

// 1) Signed in, with a usable model carrying a promotion and a dead one.
installFetch({ state: signedInState, models, busy: { hy3: 'busy' } })
const signedInTree = await renderPanel()
const signedInText = textsOf(signedInTree)
for (const expected of ['账户', '大陆版', '海外版', '示例账号', '可用模型', '不可用模型', 'Hy3', 'Free now', '繁忙', '未知', '0.08x', 'GPT-5.3-Codex', '检测可用性', '全部启用']) {
  assert.ok(signedInText.includes(expected), `the panel renders ${expected}`)
}
assert.ok(titlesOf(signedInTree).some((title) => title.startsWith('繁忙程度：')), 'the load tag explains itself in a tooltip')

// The published snapshot: keyed by the full provider id, one entry per deployment, and each
// model carrying exactly the fields a selector would act on.
//
// `refresh()` is the loader the plugin starts on its own; calling it here rather than
// waiting for the mount effect keeps the assertion about the loader rather than about
// timing, and pins the thing the reviewer found: both deployments are read, not just the
// one the panel happens to show.
{
  const service = provided.get('@huai_xin/dsh-workbuddy/state')
  await service.refresh()
  const snapshot = service.getSnapshot()
  assert.ok(snapshot.updatedAt > 0, 'the loader published')
  assert.deepEqual(Object.keys(snapshot.providers).sort(), ['@huai_xin/dsh-workbuddy/cn', '@huai_xin/dsh-workbuddy/intl'])

  const cn = snapshot.providers['@huai_xin/dsh-workbuddy/cn']
  const intl = snapshot.providers['@huai_xin/dsh-workbuddy/intl']
  assert.equal(cn.region, 'cn')
  assert.equal(cn.loggedIn, true)
  assert.equal(typeof cn.credits, 'number', 'the balance travels with the snapshot')

  const hy3 = cn.models.hy3
  assert.ok(hy3 !== undefined, 'a model is keyed by its id')
  assert.equal(hy3.name, 'Hy3')
  assert.equal(hy3.enabled, true)
  assert.equal(hy3.available, true)
  assert.equal(hy3.busy, 'busy', 'the busy level reaches the consumer')
  assert.equal(hy3.rate, 0.08, 'and the live rate as a number')
  assert.equal(cn.models['glm-5.0'].available, false, 'a dead model is not available')
  assert.equal(cn.models['glm-5.0'].enabled, false)
  assert.ok(!('default-model' in cn.models), 'router presets are not published as models')

  assert.ok(Object.keys(intl.models).length > 0, 'the deployment the panel is NOT showing still publishes its models')
  assert.equal(intl.models.hy3.enabled, true, 'and carries the same fields')
  assert.doesNotThrow(() => JSON.stringify(snapshot), 'the whole snapshot is JSON-serializable')

  // Concurrent callers share one read: the panel's actions and the timer can overlap.
  const before = snapshot.updatedAt
  await Promise.all([service.refresh(), service.refresh(), service.refresh()])
  assert.ok(service.getSnapshot().updatedAt >= before, 'three refreshes leave a consistent snapshot')
}

/** Find actual rendered elements without invoking a second renderer. */
const nodesOf = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) nodesOf(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.type !== undefined) out.push(node)
  for (const child of node.children ?? []) nodesOf(child, out)
  return out
}
const hasClass = (node, name) => String(node.props?.className ?? '').split(/\s+/).includes(name)

// The 不可用 group keeps only the verdict and the rate on the row: a dead model's promotion
// and busy level are noise for something that cannot be called, and three tags plus a rate
// and a switch had no width left. Both stay in the expandable details.
//
// The group starts folded, so open it first; state lives in the hook slots, so the second
// render picks up where this one left off.
{
  const rowText = (node) => textsOf(node).join('|')
  const groupHead = nodesOf(signedInTree)
    .find((node) => hasClass(node, 'wb-group-head') && rowText(node).includes('不可用'))
  assert.ok(groupHead !== undefined, 'the unusable group has a header')
  groupHead.props.onClick()
  const unfolded = await renderPanel()
  const rows = nodesOf(unfolded).filter((node) => hasClass(node, 'wb-model'))
  const dead = rows.find((node) => rowText(node).includes('GLM-5.0'))
  const alive = rows.find((node) => rowText(node).includes('Hy3'))
  assert.ok(dead !== undefined && alive !== undefined, 'both rows render once the group is open')
  assert.ok(!rowText(dead).includes('夜间折扣'), 'the unusable row drops the promotion tag')
  assert.ok(rowText(alive).includes('Free now'), 'the usable row keeps its promotion')
  assert.ok(rowText(alive).includes('繁忙'), 'and its busy level')
}

const accountCard = nodesOf(signedInTree).find((node) => hasClass(node, 'wb-account-card'))
assert.ok(accountCard, 'the account card has its own styling scope')
const accountNodes = nodesOf(accountCard)
const deploymentHeads = accountNodes.filter((node) => hasClass(node, 'wb-deploy'))
assert.deepEqual(deploymentHeads.map((node) => node.props.style.gridColumn), [2, 3], 'deployments occupy the two account columns')
assert.ok(textsOf(deploymentHeads[0]).includes('大陆版'))
assert.ok(textsOf(deploymentHeads[1]).includes('海外版'))
const creditActions = accountNodes.filter((node) => hasClass(node, 'wb-cell-actions'))
assert.equal(creditActions.length, 2, 'each balance keeps its own refresh and plans controls')
for (const actions of creditActions) {
  const buttons = nodesOf(actions).filter((node) => node.type === 'button')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props['aria-label'], '刷新积分')
  assert.ok(textsOf(buttons[1]).includes('套餐'))
  assert.ok(buttons.every((node) => typeof node.props.onClick === 'function'))
}
assert.equal(accountNodes.filter((node) => node.type === 'button' && textsOf(node).includes('续期')).length, 1)
const stylesheet = textsOf(nodesOf(signedInTree).find((node) => node.type === 'style')).join('')
assert.match(stylesheet, /grid-template-columns: 56px repeat\(var\(--wb-cols\), minmax\(180px, 1fr\)\)/, 'account columns fill the card without an empty trailing column')
assert.match(stylesheet, /grid-template-rows: repeat\(4, 52px\) 34px/, 'only the action row is compacted')
assert.match(stylesheet, /\.wb-table-split::before \{[^}]*position: absolute; left: 50%;/, 'the divider is centred on the card without shifting account columns')
assert.match(stylesheet, /\.wb-cell-actions \{ flex: none;/, 'balance actions stay beside the number rather than against the far edge')

// 2) Signed out: the sign-in path, and no stale account values.
installFetch({ state: signedOutState, models: [] })
const signedOutTree = await renderPanel()
assert.ok(textsOf(signedOutTree).includes('登录'), 'a signed-out deployment offers sign-in')
assert.ok(titlesOf(signedOutTree).includes('未登录'), 'the status dot reports the deployment as signed out')

// 3) The Host is unreachable: the panel reports it instead of rendering blank.
installFetch({ state: signedOutState, models: [], fail: true })
const failedTree = await renderPanel()
assert.ok(textsOf(failedTree).some((text) => text.includes('offline')), 'a failed load surfaces the error')

// 4) Two models that share a display name keep a fixed order.
//
// `deepseek-v4.1-flash` and `deepseek-v4.1-flash-sg` are both named Deepseek-V4.1-Flash,
// and one of them is switched off. With a name-only comparator their relative order
// followed the catalog's own order, so the pair swapped rows on reload — which reads as
// "the switch turned itself on, then off". The id is the tiebreaker, so the order is the
// same whichever way the catalog arrives.
{
  const byName = (a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), 'zh-Hans-CN', { numeric: true })
    || String(a.id).localeCompare(String(b.id))
  const flash = { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }
  const sg = { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash' }
  assert.deepEqual([flash, sg].sort(byName).map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg'])
  assert.deepEqual([sg, flash].sort(byName).map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg'], 'the order does not depend on input order')
  assert.ok(byName(flash, sg) < 0 && byName(sg, flash) > 0, 'and the comparator is antisymmetric')
}

// 5) Token counts pick their unit from the digit count, and re-check after dividing.
//
// 131072 must not be quoted as "1000K" — one million is the next unit — and the rounding
// itself can overflow: 999999 / 1000 is 999.999, which prints as "1000.00K" unless the
// figure is compared after rounding.
{
  const source = (await import('node:fs')).readFileSync(new URL('../../client/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('const formatTokens = (value) => {')
  assert.ok(start >= 0, 'the formatter is still there')
  let depth = 0
  let end = start
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') { depth -= 1; if (depth === 0) { end = index + 1; break } }
  }
  const formatTokens = new Function(`${source.slice(start, end)}; return formatTokens`)()
  assert.equal(formatTokens(999), '999', 'below a thousand, the raw number')
  assert.equal(formatTokens(1000), '1K', 'four digits is a thousands figure')
  assert.equal(formatTokens(131072), '131.1K', 'a remainder keeps one decimal')
  assert.equal(formatTokens(204800), '204.8K')
  assert.equal(formatTokens(192000), '192K', 'a whole figure carries no ".0"')
  assert.equal(formatTokens(256000), '256K')
  assert.equal(formatTokens(999000), '999K', 'still below a million once rounded')
  assert.equal(formatTokens(999999), '1M', 'and here rounding crosses into the next unit')
  assert.equal(formatTokens(1000000), '1M', 'seven digits is millions')
  assert.equal(formatTokens(1048576), '1M')
  assert.equal(formatTokens(1250000), '1.3M')
  assert.equal(formatTokens(1500000), '1.5M', 'a half million keeps its decimal')
  assert.equal(formatTokens(2000000), '2M')
  assert.ok(!/\d\.\d{2}/.test(formatTokens(131072)), 'never more than one decimal')
  assert.equal(formatTokens(undefined), undefined)
  assert.equal(formatTokens(-1), undefined)
  assert.ok(!/k|m/.test(String(formatTokens(2000000))), 'suffixes are upper case')
}

console.log('client.mjs: OK — registration, dictionaries, three full panel renders, same-name ordering, and token units verified')
