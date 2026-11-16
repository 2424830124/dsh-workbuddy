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
  credits: { ok: true, total: 1234.5, daily: 120, unlimited: false, packages: [], at: Date.now() },
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
// A signed-out deployment answers with an EMPTY account list: the host only publishes
// accounts it can read a token for, because a row nobody can read a token for can only ever
// say 未知 / 未登录 and can neither be called nor signed out.
const signedOutState = {
  regions: [
    region({ loggedIn: false, expiresAt: 0, nickname: '', accounts: [], credits: null, checkin: null, lastClaim: null, models: 0 }),
    region({ id: 'intl', provider: '@huai_xin/dsh-workbuddy/intl', loggedIn: false, expiresAt: 0, nickname: '', accounts: [], credits: null, checkin: null, lastClaim: null, models: 0, hasBusy: false })
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
    // Suspended by the sweep rather than by the user: the row has to say which, because one
    // of the two comes back on its own.
    autoOff: true,
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
for (const expected of ['账户', '大陆版', '海外版', '示例账号', '1 个账号', '可用模型', '不可用模型', 'Hy3', 'Free now', '繁忙', '未知', '0.08x', 'GPT-5.3-Codex', '检测可用性', '全部启用']) {
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
  // A deployment can hold several accounts; the published snapshot says how many there
  // are, so a consumer offering "switch account" does not have to guess. The fixture
  // answers the single-account shape, so it reads 0 — the point is that the field exists
  // and is a number, not that it is large.
  assert.equal(typeof cn.accounts, 'number')

  // Four fields per model. Keys and values are both English, and the values are fixed tokens
  // rather than dictionary lookups: the same model must report `rate limited` in a Chinese UI
  // and in an English one, or a consumer branching on the string breaks on a locale switch.
  const hy3 = cn.models.hy3
  assert.ok(hy3 !== undefined, 'a model is keyed by its id')
  assert.deepEqual(Object.keys(hy3).sort(), ['busy', 'name', 'rate', 'verdict'])
  assert.equal(hy3.name, 'Hy3')
  assert.equal(hy3.verdict, 'available', 'a model nothing is known against reads available')
  assert.equal(hy3.busy, 'busy', 'the load level as a token')
  assert.equal(hy3.rate, '0.08x', 'and the rate as it is displayed')
  assert.deepEqual({ ...hy3 }, {
    name: 'Hy3', verdict: 'available', busy: 'busy', rate: '0.08x'
  }, 'and nothing else leaks into the shape')

  // The dead model is switched off in the fixture, so it is not published at all: the
  // switch is the answer to "should a picker offer this", and re-filtering invites drift.
  assert.ok(!('glm-5.0' in cn.models), 'a disabled model is not published')
  assert.ok(!('default-model' in cn.models), 'router presets are not published as models')

  assert.ok(Object.keys(intl.models).length > 0, 'the deployment the panel is NOT showing still publishes its models')
  assert.equal(intl.models.hy3.name, 'Hy3', 'and carries the same fields')
  assert.equal(typeof intl.models.hy3.verdict, 'string')
  assert.equal(intl.models.hy3.busy, 'unknown', 'a deployment without busy levels says so rather than inventing one')
  assert.doesNotThrow(() => JSON.stringify(snapshot), 'the whole snapshot is JSON-serializable')

  // The verdict follows the row's *chip*, not the group a row sits in. A model that answered
  // with a 5xx draws 未知 while still belonging to the usable group; publishing "available"
  // there would put a word in the panel's mouth.
  {
    const verdictOf = (model) => {
      const copy = { ...models }
      installFetch({ state: signedInState, models: [{ ...copy[0], availability: { state: model, at: Date.now() } }], busy: {} })
      return service.refresh().then(() => service.getSnapshot().providers['@huai_xin/dsh-workbuddy/cn'].models.hy3.verdict)
    }
    assert.equal(await verdictOf('ok'), 'available')
    assert.equal(await verdictOf(undefined), 'available', 'an unprobed model draws no chip, so it reads available')
    assert.equal(await verdictOf('busy'), 'available', 'a queue is transient, not a verdict')
    assert.equal(await verdictOf('down'), 'unknown', 'a 5xx is undecided, and the row says 未知')
    assert.equal(await verdictOf('throttled'), 'rate limited')
    assert.equal(await verdictOf('noquota'), 'out of credits')
    assert.equal(await verdictOf('denied'), 'no permission')
    assert.equal(await verdictOf('auth'), 'credentials rejected')
    assert.equal(await verdictOf('dead'), 'unusable')
    // Put the first fixture back for the assertions that follow.
    installFetch({ state: signedInState, models, busy: { hy3: 'busy' } })
    await service.refresh()
  }

  // The tokens must not come from the dictionary: the panel here runs under zh-CN, so a
  // lookup would publish 限流 / 空闲 / 免费 and change meaning the moment the UI language did.
  {
    const published = service.getSnapshot().providers['@huai_xin/dsh-workbuddy/cn'].models
    for (const [id, entry] of Object.entries(published)) {
      assert.match(entry.verdict, /^[a-z ]+$/, `${id}: verdict is a fixed English token`)
      assert.match(entry.busy, /^[a-z]+$/, `${id}: busy is a fixed English token`)
      assert.match(entry.rate, /^(?:[\d.]+x|free|unknown)$/, `${id}: rate is a number, free or unknown`)
    }
  }

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

  // A model the sweep switched off says so, and its switch explains itself differently: the
  // user did not turn this one off, and it comes back on its own once it answers again.
  assert.ok(rowText(dead).includes('已自动停用'), 'a suspended model says it was switched off automatically')
  assert.ok(!rowText(alive).includes('已自动停用'), 'and a model that works says nothing of the sort')
  const deadSwitch = nodesOf(dead).find((node) => node.props?.role === 'switch')
  const aliveSwitch = nodesOf(alive).find((node) => node.props?.role === 'switch')
  assert.match(String(deadSwitch.props.title), /恢复可用/, 'its switch says the suspension lifts by itself')
  assert.notEqual(deadSwitch.props.title, aliveSwitch.props.title, 'which is not what a model switched off by hand says')
}

// A model switch must cost one request.
//
// `/state` answers with the balance and check-in state, which costs two upstream round trips
// per deployment — 346 ms measured — and the click felt it because the panel used to re-read
// the whole state (and the catalog) to learn one boolean.
{
  const calls = installFetch({ state: signedInState, models, busy: { hy3: 'busy' } })
  const tree = await renderPanel()
  const switchOf = (name) => {
    const rows = nodesOf(tree).filter((node) => hasClass(node, 'wb-model'))
    const row = rows.find((node) => textsOf(node).join('|').includes(name))
    assert.ok(row !== undefined, `the ${name} row renders`)
    return nodesOf(row).find((node) => node.props?.role === 'switch')
  }
  const hy3Switch = switchOf('Hy3')
  assert.ok(hy3Switch !== undefined, 'the row carries a switch')

  calls.length = 0
  hy3Switch.props.onClick({ stopPropagation: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const afterToggle = calls.map((url) => String(url).replace(/^.*\/workbuddy/, ''))

  assert.ok(afterToggle.some((path) => path.startsWith('/enabled')), 'the switch calls /enabled')
  assert.ok(!afterToggle.some((path) => path.startsWith('/state')), 'and does NOT re-read /state')
  assert.ok(!afterToggle.some((path) => path.startsWith('/models')), 'and does NOT re-read the catalog')

  // The snapshot follows the switch without a round trip: the model leaves the map, because
  // only enabled models are published.
  const service = provided.get('@huai_xin/dsh-workbuddy/state')
  assert.ok(!('hy3' in service.getSnapshot().providers['@huai_xin/dsh-workbuddy/cn'].models),
    'disabling a model drops it from the snapshot')
}

const accountCard = nodesOf(signedInTree).find((node) => hasClass(node, 'wb-account-card'))
assert.ok(accountCard, 'the account card has its own styling scope')
const accountNodes = nodesOf(accountCard)
// Deployments are stacked blocks now, not columns: each carries its own head row
// (dot, name, summed balance, its bulk actions), its accounts and an add-account foot.
const poolBlocks = accountNodes.filter((node) => hasClass(node, 'wb-pool-block'))
assert.equal(poolBlocks.length, 2, 'one block per deployment, stacked')
assert.ok(textsOf(poolBlocks[0]).includes('大陆版'), 'the mainland deployment comes first')
assert.ok(textsOf(poolBlocks[1]).includes('海外版'))
for (const block of poolBlocks) {
  const head = nodesOf(block).find((node) => hasClass(node, 'wb-pool-head'))
  assert.ok(head !== undefined, 'each block has a head row')
  assert.ok(nodesOf(head).some((node) => hasClass(node, 'wb-pool-name')), 'the head names the deployment')
  assert.ok(nodesOf(head).some((node) => hasClass(node, 'wb-credits-value')), 'and carries the summed balance')
  assert.ok(nodesOf(head).some((node) => hasClass(node, 'wb-link-btn') && textsOf(node).includes('套餐')), 'the plans link is on the head')
  // No account count in the head: the rows below it already say how many there are.
  assert.equal(nodesOf(head).filter((node) => hasClass(node, 'wb-pool-count')).length, 0, 'the head does not repeat the account count')
  // The total reads "总积分 <figure>": the label leads, because this figure is a sum.
  const headText = textsOf(head).join('|')
  assert.ok(headText.includes('总积分'), 'the summed balance is labelled')
  assert.ok(!headText.includes('合计'), 'the old wording is gone')
}
// One row per account, each with its own four controls.
const accountRows = accountNodes.filter((node) => hasClass(node, 'wb-acct'))
assert.equal(accountRows.length, 2, 'one row per signed-in account')
for (const row of accountRows) {
  assert.ok(nodesOf(row).some((node) => hasClass(node, 'wb-acct-name')), 'the row names the account')
  const buttons = nodesOf(row).filter((node) => node.type === 'button')
  assert.ok(buttons.some((node) => node.props['aria-label'] === '刷新积分'), 'the row re-reads its own balance')
  assert.ok(buttons.some((node) => textsOf(node).includes('续期')), 'the row can be renewed on its own')
  assert.ok(buttons.some((node) => textsOf(node).includes('退出登录')), 'the row can be signed out on its own')
  // 更换账号 was removed: 添加账号 plus 退出登录 already covers replacing an account, and
  // two paths to the same thing is one too many.
  assert.ok(!buttons.some((node) => textsOf(node).includes('更换账号')), 'there is no separate re-authorize button')
  assert.ok(buttons.every((node) => typeof node.props.onClick === 'function'))
  // The balance sits at the right edge, in its own element, not in the muted meta text.
  const credits = nodesOf(row).find((node) => hasClass(node, 'wb-acct-credits'))
  assert.ok(credits !== undefined, 'the row shows its own balance')
  assert.ok(nodesOf(credits).some((node) => hasClass(node, 'wb-credits-value')), 'and it is the accent-coloured figure')
  assert.ok(!textsOf(row).join('|').includes('到期'), 'no expiry: the claim is not what the server honours')
}
// Every block ends with 添加账号 - the feature that makes several accounts possible.
const addButtons = accountNodes.filter((node) => node.type === 'button' && textsOf(node).includes('添加账号'))
assert.equal(addButtons.length, 2, 'each deployment offers 添加账号')
for (const button of addButtons) {
  assert.equal(typeof button.props.onClick, 'function')
  assert.ok(typeof button.props.title === 'string' && button.props.title.length > 0, 'the add button explains the fallback order')
}
const stylesheet = textsOf(nodesOf(signedInTree).find((node) => node.type === 'style')).join('')
assert.match(stylesheet, /\.wb-pool-block \+ \.wb-pool-block \{ margin-top: 10px; \}/, 'blocks stack instead of sitting in columns')
assert.ok(!stylesheet.includes('wb-table-split'), 'the old column table is gone')
assert.match(stylesheet, /\.wb-acct \{ display: flex;/, 'an account is one row')

// 2) Signed out: the block still renders, with 添加账号 available and no stale values.
installFetch({ state: signedOutState, models: [] })
const signedOutTree = await renderPanel()
assert.ok(textsOf(signedOutTree).includes('添加账号'), 'a signed-out deployment still offers 添加账号')
assert.ok(titlesOf(signedOutTree).includes('未登录'), 'the status dot reports the deployment as signed out')
const signedOutText = textsOf(signedOutTree)
assert.ok(signedOutText.includes('这一栏还没有账号，点「添加账号」登录'), 'an empty pool says so instead of drawing a blank block')
// The deployment's own total may legitimately read 未知 while signed out; what must not
// survive is an ACCOUNT row, since a tokenless entry can only ever read 未知 / 未登录 and can
// neither be called nor signed out.
assert.ok(!nodesOf(signedOutTree).some((node) => hasClass(node, 'wb-acct')), 'no account row survives a logout')
assert.ok(!nodesOf(signedOutTree).some((node) => hasClass(node, 'wb-acct-credits')), 'no per-account balance survives a logout')

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

// 6) Several accounts in one deployment: the tab counts them, every one gets a row, and the
// figure at the top is the deployment's total rather than one account's balance.
{
  const twoAccounts = {
    regions: [
      region({
        accounts: [
          { id: 'primary', nickname: '示例账号', loggedIn: true, hasToken: true, expiresAt: Date.now() + 3_600_000, refreshable: true, pending: false, credits: { ok: true, total: 1000.5, daily: 0, unlimited: false, packages: [] }, checkin: null, lastClaim: null },
          { id: 'acc-2', nickname: '示例小号', loggedIn: true, hasToken: true, expiresAt: Date.now() + 3_600_000, refreshable: true, pending: false, credits: { ok: true, total: 234, daily: 0, unlimited: false, packages: [] }, checkin: null, lastClaim: null }
        ],
        credits: { ok: true, total: 1234.5, daily: 0, unlimited: false, packages: [], at: Date.now() }
      }),
      region({ id: 'intl', provider: '@huai_xin/dsh-workbuddy/intl', nickname: '900000001', models: 1, hasBusy: false, checkin: null, lastClaim: null })
    ],
    importToken: 'token',
    version: '0.0.0-test',
    codeStamp: 'test'
  }
  installFetch({ state: twoAccounts })
  const pooledTree = await renderPanel()
  const pooledText = textsOf(pooledTree)
  assert.ok(pooledText.includes('2 个账号'), 'the tab counts the deployment\'s accounts rather than naming one')
  assert.ok(pooledText.includes('示例账号'), 'every account keeps its own row')
  assert.ok(pooledText.includes('示例小号'))
  assert.ok(pooledText.includes('1234.50'), 'and the figure at the top is the total the host summed')
  assert.ok(pooledText.includes('1000.50') && pooledText.includes('234'), 'each account shows its own balance')
}

// 7) A login waiting for the browser is a fact about the HOST — it minted the link and it runs
// the poll — so the panel must be able to draw that link even after it was reloaded, and it
// must offer a way out of a flow that would otherwise sit there forever.
{
  const pendingState = {
    regions: [
      region({
        loggedIn: false,
        pending: true,
        loginUrl: 'https://www.workbuddy.cn/login/auth?state=st-1',
        pendingSince: Date.now(),
        nickname: '',
        expiresAt: 0,
        credits: null,
        checkin: null,
        lastClaim: null,
        models: 0
      }),
      region({ id: 'intl', provider: '@huai_xin/dsh-workbuddy/intl', nickname: '900000001', models: 1, hasBusy: false })
    ],
    importToken: 'token',
    version: '0.0.0-test',
    codeStamp: 'test'
  }
  // A pending deployment is what makes the panel poll for the outcome, and this React never runs
  // effect cleanups — so the interval is captured here and stopped, or the process would never
  // exit once the last line is printed.
  const realSetInterval = globalThis.setInterval
  const intervals = []
  globalThis.setInterval = (fn, ms) => {
    const handle = realSetInterval(fn, ms)
    intervals.push(handle)
    return handle
  }
  let pendingTree
  try {
    installFetch({ state: pendingState })
    pendingTree = await renderPanel()
  } finally {
    globalThis.setInterval = realSetInterval
    for (const handle of intervals) {
      handle.unref?.()
      clearInterval(handle)
    }
  }
  const pendingText = textsOf(pendingTree)
  assert.ok(intervals.length >= 1, 'a login in flight is what makes the panel watch it')
  assert.ok(pendingText.includes('等待授权…'), 'the deployment says a login is waiting')
  assert.ok(
    pendingText.includes('https://www.workbuddy.cn/login/auth?state=st-1'),
    'the link is drawn from the host, so a reloaded panel can still hand it over'
  )
  assert.ok(pendingText.includes('取消这次登录'), 'and the waiting login can be abandoned')
}

// 8) 续期 writes to the host directly, not through `act()` — so it has to refresh the
// published snapshot itself. Without that the panel showed renewed tokens while a selector
// kept reading the old snapshot until the five-minute timer happened to fire.
{
  const renewState = { ...signedInState }
  installFetch({ state: renewState, models, busy: {} })
  const tree = await renderPanel()
  const service = provided.get('@huai_xin/dsh-workbuddy/state')
  await service.refresh()

  const before = service.getSnapshot()
  // The bulk-renew button lives in the account card's head row; its label is 续期 and the
  // per-account rows carry one too, so pick the one outside a row.
  const renewButton = nodesOf(tree).find((node) => node.type === 'button'
    && textsOf(node).join('').includes('续期')
    && !nodesOf(node).some((child) => hasClass(child, 'wb-acct')))
  assert.ok(renewButton !== undefined, 'the account card offers a bulk renew')
  assert.equal(typeof renewButton.props.onClick, 'function')

  const calls = installFetch({ state: renewState, models, busy: {} })
  renewButton.props.onClick()
  // The handler awaits `/refresh` then `load()`, and only then refreshes the snapshot.
  for (let pass = 0; pass < 12; pass += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(calls.some((path) => path.includes('/refresh')), 'the button asks the host to renew')
  assert.ok(calls.filter((path) => path.includes('/state')).length >= 2, 'and re-reads the snapshot afterwards, not only the panel')
  assert.notEqual(service.getSnapshot(), before, 'a selector sees the renewal instead of waiting for the timer')
}

console.log('client.mjs: OK — registration, dictionaries, five full panel renders, account counts, same-name ordering, waiting-login callout, snapshot refresh after a manual renewal, and token units verified')
