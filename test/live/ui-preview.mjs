/**
 * Dev probe: render the settings panel's markup and stylesheet to a standalone
 * HTML file, so the visual design can be reviewed (and screenshotted) without
 * driving the DSH Web GUI. The CSS is extracted from the real client bundle and
 * the markup mirrors the component's render output with representative data.
 *
 * Run: `node test/live/ui-preview.mjs` → writes $TEMP/wb-ui-preview.html
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = readFileSync(new URL('../../client/index.js', import.meta.url), 'utf8')
const start = source.indexOf('const CSS = `')
const end = source.indexOf('\n`', start)
if (start < 0 || end < 0) throw new Error('CSS block not found')
const css = source.slice(start + 'const CSS = `'.length, end)

const cnModels = [
  { id: 'hy3', name: 'Hy3', official: true, credits: '0.00x', state: 'ok' },
  { id: 'hy4-preview', name: 'Hy4 preview', official: true, credits: '0.29x', state: 'busy' },
  { id: 'glm-5.3', name: 'GLM-5.3', official: true, credits: '0.69x', state: 'ok' },
  { id: 'glm-5.2', name: 'GLM-5.2', official: true, credits: '0.79x', state: null },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', official: true, credits: '0.11x', state: null },
  { id: 'kimi-k3-1', name: 'Kimi-K3', official: true, credits: '1.62x', state: null },
  { id: 'step-5-preview', name: 'Step-5-Preview', official: true, credits: '0.00x', state: null },
  { id: 'hy3-x', name: 'Hy3 X', official: false, credits: '0.05x', state: null },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', official: false, credits: '0.45x', state: 'ok' },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', official: false, credits: '0.17x', state: 'ok' },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', official: false, credits: undefined, state: 'dead' }
]

const intlModels = [
  {
    id: 'hy3',
    name: 'Hy3',
    enabled: true,
    credits: '0.00x',
    free: true,
    state: 'ok',
    open: true,
    promo: 'Free now',
    promoKind: '折扣',
    promoWindow: '2026/8/6 00:00:00 → 2026/11/1 00:00:00',
    promoText: 'Aug 6 – Oct 31: Free daily use with unlimited credits.',
    busy: '空闲',
    busyTone: 'wb-tag-ok',
    contextWindow: '192k',
    maxTokens: '64k',
    input: '文本 + 图像',
    efforts: 'low / high',
    description: '腾讯混元最新一代快思考模型，响应快、成本低，适合日常问答与轻量编码。'
  },
  { id: 'hy4-preview', name: 'Hy4 preview', enabled: true, credits: '0.29x', state: 'ok', busy: '繁忙', busyTone: 'wb-tag-warn' },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', enabled: true, credits: '0.00x', state: 'ok' },
  { id: 'glm-5.3', name: 'GLM-5.3', enabled: true, credits: '0.69x', state: 'ok' },
  { id: 'glm-5.2', name: 'GLM-5.2', enabled: false, credits: '0.79x', state: 'ok' },
  { id: 'kimi-k3', name: 'Kimi-K3', enabled: true, credits: '1.62x', state: 'ok' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', enabled: true, credits: '0.52x', state: 'ok' },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', enabled: true, credits: '0.21x', state: 'ok' },
  { id: 'step-5-preview', name: 'Step-5-Preview', enabled: true, credits: '0.00x', state: 'ok' },
  { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', enabled: true, credits: '0.03x', state: 'down' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', enabled: true, credits: '0.31x', state: 'error' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', enabled: false, credits: '3.47x', state: 'denied' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', enabled: false, credits: '1.39x', state: 'denied' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', enabled: false, credits: '0.14x', state: 'denied' },
  { id: 'gpt-5.5', name: 'GPT-5.5', enabled: false, credits: '3.31x', state: 'denied' },
  { id: 'gpt-5.4', name: 'GPT-5.4', enabled: false, credits: '1.65x', state: 'denied' },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', enabled: false, credits: '0.99x', state: 'denied' },
  { id: 'grok-4.7', name: 'Grok-4.7', enabled: false, credits: '1.90x', state: 'denied' },
  { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex', enabled: true, credits: undefined, state: null },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', enabled: false, credits: '6.67x', state: 'denied' }
]

const dot = (state) => {
  const color = state === 'dead' ? 'var(--dsw-alias-state-error-primary, #e5484d)'
    : state === 'denied' ? 'var(--dsw-alias-state-warn-primary, #d89614)'
      : state === 'busy' ? 'var(--dsw-alias-state-warn-primary, #d89614)'
        : state === 'ok' ? 'var(--dsw-alias-state-success-primary, #3fa45b)'
          : 'var(--dsw-alias-state-idle-primary, #8a8f98)'
  return `<span class="wb-model-dot" style="background:${color}"></span>`
}

const CHIP = { dead: '不可用', denied: '无权限', blocked: '无权限', down: '未知', error: '未知', auth: '未知', busy: '排队中' }
const chipTone = (state) => state === 'dead' ? ' wb-tag-bad'
  : ((state === 'denied' || state === 'blocked') ? ' wb-tag-warn' : '')

const detailRow = (label, value, wide = false) => value === undefined || value === null || value === ''
  ? ''
  : `<div class="wb-detail${wide ? ' wb-detail-wide' : ''}"><span class="wb-detail-label">${label}</span><span class="wb-detail-value">${value}</span></div>`

const tag = (text, tone = '') => `<span class="wb-tag${tone}">${text}</span>`
const tags = (list, tone = '') => `<span class="wb-tags">${list.map((item) => tag(item, tone)).join('')}</span>`

const details = (model) => `<div class="wb-model-detail">
      ${detailRow('描述', model.description, true)}
      ${detailRow('标识', model.id)}
      ${detailRow('上下文', model.contextWindow)}
      ${detailRow('最大输出', model.maxTokens)}
      ${detailRow('模态', model.input === undefined ? undefined : tags(model.input.split(' + '), ' wb-tag-accent'))}
      ${detailRow('思考档位', model.efforts === undefined ? undefined : tags(model.efforts.split(' / ')))}
      ${detailRow('倍率', model.free === true ? tag('免费', ' wb-tag-accent') : (model.credits === undefined ? '未知' : model.credits))}
      ${detailRow('繁忙', model.busy === undefined ? undefined : tag(model.busy, ` ${model.busyTone ?? 'wb-tag-ok'}`))}
      ${detailRow('促销类型', model.promo === undefined ? undefined : `<span class="wb-tag" style="background:#e5484d1f;color:#e5484d">${model.promo}</span>`)}
      ${detailRow('促销时限', model.promoWindow)}
      ${detailRow('促销详情', model.promoText, true)}
    </div>`

const row = (model) => `<div class="wb-model-block${model.open === true ? ' wb-model-block-open' : ''}">
      <div class="wb-model${model.enabled === false ? ' wb-model-off' : ''}" title="${model.id}">
        <span class="wb-caret" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 L8 6 L4.5 9.5"></path></svg></span>
        ${dot(model.state)}
        <span class="wb-model-name">${model.name ?? model.id}</span>
        <span class="wb-model-tail">
          ${model.state !== null && CHIP[model.state] !== undefined ? `<span class="wb-tag${chipTone(model.state)}">${CHIP[model.state]}</span>` : ''}
          ${model.promo === undefined ? '' : `<span class="wb-tag" style="background:#e5484d1f;color:#e5484d">${model.promo}</span>`}
          ${model.busy === undefined ? '' : `<span class="wb-tag wb-busy-column ${model.busyTone ?? 'wb-tag-ok'}"><span class="wb-tag-dot"></span>${model.busy}</span>`}
          <span class="wb-model-rate">${model.free === true ? '<span class="wb-tag wb-tag-accent" style="font-family:inherit">免费</span>' : (model.credits === undefined ? '<span class="wb-muted">未知</span>' : model.credits)}</span>
        </span>
        <button type="button" role="switch" aria-checked="${model.enabled !== false}" class="wb-switch${model.enabled === false ? '' : ' wb-switch-on'}" title="${model.enabled === false ? '在模型选择器中启用' : '在模型选择器中停用'}"><span class="wb-switch-knob"></span></button>
      </div>
      ${model.open === true ? details(model) : ''}
    </div>`

const group = (label, list, collapsed = false) => list.length === 0 ? '' : `
    <div class="wb-group-card">
      <div class="wb-group-head" aria-expanded="${collapsed !== true}"><span class="wb-caret" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 L8 6 L4.5 9.5"></path></svg></span><span>${label}</span><span class="wb-group-count">${list.length}</span></div>
      ${collapsed === true ? '' : list.map(row).join('\n      ')}
    </div>`

const groups = (list) => {
  const unusable = (model) => model.state === 'dead' || model.state === 'denied' || model.state === 'blocked'
  const byName = (a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), 'zh-Hans-CN', { numeric: true })
  return group('可用模型', list.filter((model) => !unusable(model)).sort(byName))
    + group('不可用模型', list.filter(unusable).sort(byName), true)
}

/**
 * The account card, transposed: deployments are columns, fields are rows.
 * Mirrors `accountGrid()` in the component, including the single centred
 * sign-in button a signed-out deployment gets in place of four empty rows.
 */
const accountCard = (accounts) => {
  const fields = ['账号', '到期', '积分', '操作']
  const cells = ['<span class="wb-row-label" style="grid-row:1;grid-column:1">部署</span>']
  fields.forEach((label, index) => {
    cells.push(`<span class="wb-row-label" style="grid-row:${index + 2};grid-column:1">${label}</span>`)
  })
  accounts.forEach((account, index) => {
    const column = index + 2
    cells.push(`<div class="wb-th wb-deploy" style="grid-row:1;grid-column:${column}" title="${account.endpoint}">
        <span class="wb-deploy-dot" style="background:${account.statusColor}" title="${account.status}"></span>
        <span>${account.region}</span>
        ${account.checkin ? `<button type="button" class="wb-btn"${account.checkedIn ? ' disabled' : ''} title="上次自动领取：2026/10/21 09:12:03 · +300 积分">${account.checkedIn ? '今日已签到' : '立即领取'}</button>` : ''}
      </div>`)
    if (!account.loggedIn) {
      // While the first answer is still in flight the cell says so instead of
      // offering a sign-in button; that is what `loading` renders below.
      cells.push(`<div class="wb-td wb-td-span" style="grid-row:2 / span ${fields.length};grid-column:${column}">
        ${account.loading === true ? '<span class="wb-loading">加载中…</span>' : '<button type="button" class="wb-btn wb-btn-primary">登录</button>'}
      </div>`)
      return
    }
    const cell = (row, inner, last = false, extra = '') => `<div class="wb-td${last ? ' wb-td-last' : ''}${extra}" style="grid-row:${row + 2};grid-column:${column}">${inner}</div>`
    cells.push(cell(0, `<span class="wb-account-name">${account.nickname}</span>`))
    cells.push(cell(1, `<span class="wb-num">${account.expires}</span>`))
    cells.push(cell(2, `<span class="wb-credits-value">${account.credits}</span>
        <span class="wb-cell-actions">
          <button type="button" class="wb-icon-btn" title="刷新积分">⟳</button>
          <button type="button" class="wb-link-btn" title="在浏览器打开该部署的官方套餐页（用量与订阅）">套餐</button>
        </span>`, false, ' wb-td-credits'))
    cells.push(cell(3, `<button type="button" class="wb-btn wb-btn-primary">更换账号</button>
        <button type="button" class="wb-btn wb-btn-danger">退出登录</button>`, true))
  })
  return `<div class="wb-card wb-account-card">
    <div class="wb-card-head">
      <span class="wb-logo" aria-hidden="true"></span>
      <span class="wb-card-title">账户</span>
      <div class="wb-head-right"><button type="button" class="wb-btn" title="两个部署一起续期（未登录的跳过）">续期</button></div>
    </div>
    <div class="wb-table wb-table-split" role="table" style="--wb-cols:${accounts.length}">
      ${cells.join('\n      ')}
    </div>
  </div>`
}

const panel = (options) => `<section class="wb-root">
  <h2 class="wb-title">WorkBuddy 模型</h2>
  <p class="wb-intro">两个部署各自独立登录；切换标签只切换查看，不影响已登录的账号。积分会在软件启动时和每天 0 点自动领取一次。</p>
  ${accountCard(options.accounts)}
  <div class="wb-card">
    <div class="wb-tabs" role="tablist">
      <button type="button" class="wb-tab${options.active === 'cn' ? ' wb-tab-on' : ''}"><span class="wb-tab-dot" style="color:#3fa45b;background:#3fa45b"></span>大陆版<span class="wb-tab-sub">示例账号</span></button>
      <button type="button" class="wb-tab${options.active === 'intl' ? ' wb-tab-on' : ''}"><span class="wb-tab-dot" style="color:#3fa45b;background:#3fa45b"></span>海外版<span class="wb-tab-sub">900000001</span></button>
    </div>
    <div class="wb-section-head">
      <span class="wb-section-title">模型</span>
      <span class="wb-badge">${options.models.length} 个</span>
      ${options.sourceHint ? `<span class="wb-muted">${options.sourceHint}</span>` : ''}
      ${options.importedHint ? `<span class="wb-muted">${options.importedHint}</span>` : ''}
      <span class="wb-availability">检测：可用 ${options.models.filter((model) => model.state !== 'dead' && model.state !== 'denied' && model.state !== 'blocked').length} / 不可用 ${options.models.filter((model) => model.state === 'dead' || model.state === 'denied' || model.state === 'blocked').length}</span>
      <button type="button" class="wb-icon-btn" title="刷新列表" aria-label="刷新列表">⟳</button>
      <button type="button" class="wb-btn wb-btn-ghost">检测可用性</button>
    </div>
    <div class="wb-tools">
      <span class="wb-search"><input type="search" placeholder="搜索模型" value=""${options.disabled ? ' disabled' : ''}></span>
      <button type="button" class="wb-btn wb-btn-ghost"${options.disabled ? ' disabled' : ''}>全部启用</button>
      <button type="button" class="wb-btn wb-btn-ghost"${options.disabled ? ' disabled' : ''}>全部停用</button>
    </div>
    <div class="wb-models-body">${options.disabled ? '<div class="wb-empty">登录后这里会显示该账号可用的模型</div>' : groups(options.models)}</div>
  </div>
</section>`

const bothSignedIn = [
  { region: '大陆版', nickname: '示例账号', expires: '2027/01/16 09:00:00', credits: '1280.00', loggedIn: true, status: '已登录', statusColor: '#3fa45b', endpoint: 'workbuddy-cn · https://www.workbuddy.cn', checkin: true, checkedIn: true },
  { region: '海外版', nickname: '900000001', expires: '2027/04/21 12:00:00', credits: '360.00', loggedIn: true, status: '已登录', statusColor: '#3fa45b', endpoint: 'workbuddy-intl · https://www.workbuddy.ai', checkin: false }
]

const oneSignedOut = [
  { region: '大陆版', nickname: '', expires: '', credits: '', loggedIn: false, status: '未登录', statusColor: '#8a8f98', endpoint: 'workbuddy-cn · https://www.workbuddy.cn' },
  bothSignedIn[1]
]

/** The panel loads the mark from the Host; a file:// page cannot, so the same
 *  asset is inlined as a data URI to keep the preview faithful. */
const maskDataUri = `data:image/png;base64,${readFileSync(new URL('../../icon-mask.png', import.meta.url)).toString('base64')}`

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>WorkBuddy 面板预览</title>
<style>
body { margin: 0; padding: 28px 32px; background: #1b1d21; color: #e6e8eb;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
.frame { width: 900px; margin: 0 auto 44px; }
.label { font-size: 12px; color: #8a8f98; margin: 0 0 10px; letter-spacing: .04em; }
${css}
/* The panel loads the mark from the Host; a file:// page cannot, so the same
   asset is inlined here as a data URI to keep the preview faithful. Declared
   after the panel's own CSS so it wins. */
.wb-logo { -webkit-mask-image: url('${maskDataUri}'); mask-image: url('${maskDataUri}'); }
</style></head>
<body>
  <div class="frame"><p class="label">两个账号都已登录 · 大陆版标签</p>${panel({
    active: 'cn',
    accounts: bothSignedIn,
    models: cnModels,
    sourceHint: ''
  })}</div>
  <div class="frame"><p class="label">未登录 / 加载中：控件都在，但都点不了</p>${panel({
    active: 'cn',
    accounts: [bothSignedIn[0], { ...bothSignedIn[1], loggedIn: false, loading: true, nickname: '', expires: '', credits: '', status: '未登录', statusColor: '#8a8f98' }],
    models: [],
    disabled: true
  })}</div>
  <div class="frame"><p class="label">海外版标签（导入的账号名单）+ 海外版未登录时的账户卡片</p>${panel({
    active: 'intl',
    accounts: oneSignedOut,
    models: intlModels,
    sourceHint: '部署目录（非账号名单）',
    importedHint: '账号名单（导入于 2026/10/21 19:46:30）'
  })}</div>
</body></html>`

const out = join(tmpdir(), 'wb-ui-preview.html')
writeFileSync(out, html)
console.log(out)

