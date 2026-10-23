/**
 * Client half: the WorkBuddy page inside Settings → WorkBuddy.
 *
 * One card, two accounts: a tab strip switches which deployment's details are
 * shown, but both stay signed in independently — switching is display-only.
 * The card always lists the active account's models, and shows its credits and
 * daily check-in state (the Host claims automatically at startup and at local
 * midnight; the button here is the manual fallback).
 *
 * The accent color comes from the plugin icon (WorkBuddy green) instead of the
 * host theme, so the buttons keep their contrast in both light and dark skins.
 *
 * The packaged desktop app has no devtools, so each load stage also reports to
 * `POST /workbuddy/client-log`, which lands in the host log — that is how
 * "bundle never loaded" stays distinguishable from "loaded but apply() threw".
 */

window.__ModuleLoader__.load({
  id: '@huai_xin/dsh-workbuddy',
  factory(require) {
    const report = (stage) => {
      try {
        void fetch('/workbuddy/client-log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage }),
          keepalive: true
        }).catch(() => {})
      } catch {
        // diagnostics must never break the panel
      }
    }
    report('module-evaluated')

    const React = require('react')
    const h = React.createElement

    const API = '/workbuddy'

    const DICT = {
      'zh-CN': {
        section: 'WorkBuddy',
        title: 'WorkBuddy 模型',
        intro: '两个部署各自独立登录；切换标签只切换查看，不影响已登录的账号。积分会在软件启动时和每天 0 点自动领取一次。',
        regionIntl: '海外版',
        regionCn: '大陆版',
        cardAccounts: '账户',
        colDeploy: '部署',
        colAccount: '账号',
        colExpires: '到期',
        colCredits: '积分',
        colActions: '操作',
        refreshCredits: '刷新积分',
        openPlans: '套餐',
        openPlansHint: '在浏览器打开该部署的官方套餐页（用量与订阅）',
        openPlansFailed: (url) => `没能自动打开浏览器，请手动访问：${url}`,
        creditsRate: '消耗速度（实时）',
        models: '模型',
        login: '登录',
        switchAccount: '更换账号',
        loggingIn: '等待授权…',
        refreshList: '刷新列表',
        logout: '退出登录',
        claim: '立即领取',
        claiming: '领取中…',
        checkedIn: '今日已签到',
        lastClaim: (when, result) => `上次自动领取：${when} · ${result}`,
        claimResult: (credit) => `+${credit} 积分`,
        loading: '加载中…',
        unknown: '未知',
        count: (n) => `${n} 个`,
        loginHint: '已在系统浏览器打开授权页面；完成授权后本页会自动刷新。若浏览器没有打开，请复制下面的链接手动访问：',
        copy: '复制链接',
        copied: '已复制',
        emptyModels: '没有读取到模型',
        catalogUnavailable: '取不到模型列表，点「刷新列表」重试',
        catalogCache: '本地缓存',
        saveFailed: '保存失败，这次改动没有写入磁盘',
        checkAvailability: '检测可用性',
        checking: '检测中…',
        availabilityHint: '向白名单外的模型各发一个最小请求，判定其是否真的可用（不可用的会从列表移除）',
        availabilityResult: (ok, dead) => `检测：可用 ${ok} / 不可用 ${dead}`,
        statusLoggedIn: '已登录',
        statusLoggedOut: '未登录',
        statusExpired: '已过期',
        statusPending: '等待授权',
        search: '搜索模型',
        groupUsable: '可用模型',
        groupUnusable: '不可用模型',
        enableAll: '全部启用',
        enableAllHint: '把「可用模型」分组里的模型全部放进模型选择器（不动不可用分组）',
        disableAll: '全部停用',
        disableAllHint: '把「可用模型」分组里的模型全部移出模型选择器（不动不可用分组；面板里仍然保留，随时开回来）',
        renewBoth: '续期',
        renewBothHint: '两个部署一起续期（未登录的跳过）',
        renewing: '续期中…',
        enableModel: '在模型选择器中启用',
        disableModel: '在模型选择器中停用',
        noMatch: (query) => `没有匹配「${query}」的模型`,
        stateDead: '不可用',
        stateDenied: '无权限',
        stateUnknown: '未知',
        detailId: '标识',
        detailContext: '上下文',
        detailMaxOutput: '最大输出',
        detailEfforts: '思考档位',
        detailRate: '倍率',
        detailDescription: '描述',
        detailModality: '模态',
        freeModel: '免费',
        promoDiscount: '折扣',
        detailPromoKind: '促销类型',
        detailPromoWindow: '促销时限',
        detailPromoText: '促销详情',
        detailBusy: '繁忙程度',
        busyIdle: '空闲',
        busyBusy: '繁忙',
        busyCongested: '拥堵',
        busyBusyOfficial: '轻微拥堵',
        busyCongestedOfficial: '极度拥堵',
        busyUnknown: '未知',
        modalityText: '文本',
        modalityImage: '图像',
        noModels: '登录后这里会显示该账号可用的模型'
      },
      en: {
        section: 'WorkBuddy',
        title: 'WorkBuddy Models',
        intro: 'The two deployments sign in independently; switching tabs only changes what you are looking at. Credits are claimed automatically at startup and at local midnight.',
        regionIntl: 'Overseas',
        regionCn: 'Mainland',
        cardAccounts: 'Accounts',
        colDeploy: 'Deployment',
        colAccount: 'Account',
        colExpires: 'Expires',
        colCredits: 'Credits',
        colActions: 'Actions',
        refreshCredits: 'Refresh credits',
        openPlans: 'Plans',
        openPlansHint: 'Open this deployment’s official plans page in your browser',
        openPlansFailed: (url) => `Could not launch a browser — open this instead: ${url}`,
        creditsRate: 'Consumption rate (live)',
        models: 'Models',
        login: 'Sign in',
        switchAccount: 'Switch account',
        loggingIn: 'Awaiting authorization…',
        refreshList: 'Refresh list',
        logout: 'Sign out',
        claim: 'Claim now',
        claiming: 'Claiming…',
        checkedIn: 'Checked in today',
        lastClaim: (when, result) => `Last automatic claim: ${when} · ${result}`,
        claimResult: (credit) => `+${credit} credits`,
        loading: 'Loading…',
        unknown: 'unknown',
        count: (n) => `${n}`,
        loginHint: 'The authorization page was opened in your browser; this panel refreshes once you finish. If nothing opened, copy this link:',
        copy: 'Copy link',
        copied: 'Copied',
        emptyModels: 'No models were returned',
        catalogUnavailable: 'No model list available — try “Refresh list”',
        catalogCache: 'cached locally',
        saveFailed: 'Save failed — this change was not written to disk',
        checkAvailability: 'Check availability',
        checking: 'Checking…',
        availabilityHint: 'Probes each non-whitelisted model with one request that cannot generate tokens; unusable models are removed from the list.',
        availabilityResult: (ok, dead) => `checked: ${ok} usable / ${dead} unusable`,
        statusLoggedIn: 'Signed in',
        statusLoggedOut: 'Not signed in',
        statusExpired: 'Expired',
        statusPending: 'Awaiting authorization',
        search: 'Search models',
        groupUsable: 'Usable models',
        groupUnusable: 'Unusable models',
        enableAll: 'Enable all',
        enableAllHint: 'Offer every model in this list in the picker',
        disableAll: 'Disable all',
        disableAllHint: 'Take every model in this list out of the picker (they stay here and can be turned back on)',
        renewBoth: 'Renew',
        renewBothHint: 'Renew both deployments at once (signed-out ones are skipped)',
        renewing: 'Renewing…',
        enableModel: 'Offer this model in the picker',
        disableModel: 'Hide this model from the picker',
        noMatch: (query) => `No model matches “${query}”`,
        stateDead: 'unusable',
        stateDenied: 'no permission',
        stateUnknown: 'unknown',
        detailId: 'ID',
        detailContext: 'Context',
        detailMaxOutput: 'Max output',
        detailEfforts: 'Reasoning',
        detailRate: 'Rate',
        detailDescription: 'Description',
        detailModality: 'Modality',
        freeModel: 'free',
        promoDiscount: 'discount',
        detailPromoKind: 'Promotion',
        detailPromoWindow: 'Window',
        detailPromoText: 'Details',
        detailBusy: 'Load',
        busyIdle: 'idle',
        busyBusy: 'busy',
        busyCongested: 'congested',
        busyBusyOfficial: 'slightly congested',
        busyCongestedOfficial: 'extremely congested',
        busyUnknown: 'unknown',
        modalityText: 'text',
        modalityImage: 'image',
        noModels: 'Models appear here once the account is signed in'
      }
    }

    const dictFor = (localeId) => (String(localeId).toLowerCase().startsWith('zh') ? DICT['zh-CN'] : DICT.en)

    const CSS = `
.wb-root {
  --wb-accent: #12bfa0; --wb-accent-strong: #0da88c; --wb-accent-soft: rgba(18,191,160,.12);
  --wb-line: var(--dsw-alias-border-l1, rgba(128,138,150,.28));
  --wb-line-soft: var(--dsw-alias-border-l2, rgba(128,138,150,.16));
  /* A control's own outline, deliberately brighter than a divider: the theme's
     border tokens are tuned for separation, and they made these buttons read as
     text. Mixed from the theme's text colour, so it stays visible in either
     theme; the plain rgba is the fallback for engines without color-mix. */
  --wb-control-line: rgba(150,160,175,.45);
  --wb-control-line: color-mix(in srgb, var(--wb-text) 32%, transparent);
  --wb-muted: var(--dsw-alias-label-secondary, #9aa1ab);
  --wb-text: var(--dsw-alias-label-primary, #e6e8eb);
  --wb-surface: var(--dsw-alias-bg-layer-1, rgba(128,138,150,.04));
  --wb-surface-hover: var(--dsw-alias-bg-layer-2, rgba(128,138,150,.09));
  --wb-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-width: 820px; padding: 4px 0 40px; font-size: 13px; line-height: 1.6; color: var(--wb-text);
}
.wb-title { margin: 0 0 4px; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.wb-intro { margin: 0 0 20px; font-size: 12.5px; line-height: 1.7; color: var(--wb-muted); max-width: 62ch; }

/* cards ----------------------------------------------------------------- */
.wb-card { border: 1px solid var(--wb-line); background: var(--wb-surface); border-radius: 14px; overflow: hidden; }
.wb-card + .wb-card { margin-top: 16px; }
.wb-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 16px 12px; }
.wb-card-title { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--wb-muted); }
.wb-account-card { border-radius: 12px; border-color: var(--wb-line-soft); }
.wb-account-card .wb-card-head { gap: 10px; }
.wb-account-card .wb-card-title { letter-spacing: 0; text-transform: none; color: var(--wb-text); }
.wb-account-card .wb-btn { border-radius: 6px; }
.wb-account-card .wb-card-head .wb-btn { min-width: 52px; }
.wb-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 12px; }
/* The mark is a mask painted with the accent colour: one asset, both themes. */
.wb-logo { flex: none; width: 30px; height: 30px; display: block; background: var(--wb-accent-strong);
  -webkit-mask: url('/workbuddy/icon-mask') center / contain no-repeat;
  mask: url('/workbuddy/icon-mask') center / contain no-repeat; }

/* account table — transposed: deployments are columns, fields are rows ------
   One grid for the whole table so a signed-out deployment can occupy its whole
   column with a single centred sign-in button. */
.wb-table { display: grid; position: relative; padding: 0 10px 8px; overflow-x: auto; --wb-cols: 2;
  /* No trailing spacer: both accounts need enough width for an unbroken action
     pair in the settings column. Narrower views scroll instead of wrapping. */
  grid-template-columns: 56px repeat(var(--wb-cols), minmax(180px, 1fr));
  /* Fixed tracks prevent account loading or login from resizing the card; the
     action row needs less air than the four information rows above it. */
  grid-template-rows: repeat(4, 52px) 34px;
  column-gap: 32px; row-gap: 0; align-items: stretch; }
/* Centre the divider on the card, not the account-column gap: the label
   column makes that gap visually off-centre. Account contents stay in place. */
.wb-table-split::before { content: ''; position: absolute; left: 50%; top: 18px; bottom: 8px; width: 1px;
  transform: translateX(-50%); pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--wb-line-soft) 12%, var(--wb-line-soft) 92%, transparent); }
.wb-row-label { display: flex; align-items: center; font-size: 11px; letter-spacing: .05em;
  text-transform: uppercase; color: var(--wb-muted); }
.wb-th { min-width: 0; display: flex; align-items: center; font-size: 12.5px; font-weight: 620; white-space: nowrap; }
.wb-th .wb-btn { padding: 3px 8px; font-size: 11px; font-weight: 500; line-height: 1.2; }
.wb-deploy { display: flex; align-items: center; gap: 8px; }
.wb-deploy-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
/* The cell fills its row and holds its content left, the way the signed-in rows
   read; only the standalone sign-in cell is centred. No rule between rows: the
   spacing and the vertical separator already say where the columns are. */
.wb-td { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* Keep refresh and plans beside the balance, not at the far column edge. */
.wb-cell-actions { flex: none; display: inline-flex; align-items: center; gap: 8px; }
.wb-td-credits, .wb-td-last { flex-wrap: nowrap; }
.wb-td-last { gap: 6px; }
.wb-td-span { display: flex; align-items: center; justify-content: center; }
.wb-account-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-num { font-variant-numeric: tabular-nums; color: var(--wb-muted); }
.wb-credits-value { font-size: 16.5px; font-weight: 650; color: var(--wb-accent-strong);
  font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
/* A bare icon action: no box, just the glyph, tinted on hover. */
.wb-icon-btn { font: inherit; font-size: 13px; line-height: 1; padding: 5px 7px; border-radius: 6px; cursor: pointer;  border: 0; background: transparent; color: var(--wb-muted); transition: background .15s, color .15s; }
.wb-icon-btn:hover:not(:disabled) { background: var(--wb-accent-soft); color: var(--wb-accent-strong); }
.wb-icon-btn:disabled { opacity: .4; cursor: not-allowed; }
/* The link out to the official plans page: same quiet weight as the icon
   actions beside it, but it needs words to say where it goes — kept tight so the
   balance row still fits one line in a narrow panel. */
.wb-link-btn { font: inherit; font-size: 11px; line-height: 1; padding: 4px 7px; border-radius: 6px;
  cursor: pointer; border: 1px solid var(--wb-line-soft); background: transparent; color: var(--wb-muted);
  white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
.wb-link-btn:hover { background: var(--wb-accent-soft); color: var(--wb-accent-strong); border-color: transparent; }
.wb-td .wb-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  padding: 4px 10px; font-size: 11.5px; min-width: 78px; min-height: 26px; white-space: nowrap; }
.wb-td-span .wb-btn { padding: 7px 16px; }

/* tab strip: two equal halves, the selected one a tinted segment ------------- */
.wb-tabs { display: flex; gap: 6px; padding: 8px 16px 0; border-bottom: 1px solid var(--wb-line-soft); }
.wb-tab { font: inherit; font-size: 13px; flex: 1 1 0; justify-content: center;
  display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px 9px;
  cursor: pointer; border: 0; border-bottom: 2px solid transparent; border-radius: 9px 9px 0 0;
  background: transparent; color: var(--wb-muted);
  transition: color .15s, background .15s, border-color .15s; }
.wb-tab:hover { background: var(--wb-surface-hover); color: var(--wb-text); }
.wb-tab-on { background: var(--wb-accent-soft); color: var(--wb-accent-strong); border-bottom-color: var(--wb-accent); font-weight: 600; }
.wb-tab-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.wb-tab-sub { font-size: 11.5px; font-weight: 400; color: var(--wb-muted); }
.wb-tab-on .wb-tab-sub { color: var(--wb-accent-strong); opacity: .75; }

/* actions ---------------------------------------------------------------
   Every button reads as a control: a border, a faint fill, and a highlight on
   hover — the plain, the toolbar and the danger variants differ only in tint. */
.wb-btn { font: inherit; font-size: 12.5px; font-weight: 500; line-height: 1.2; padding: 7px 13px; border-radius: 8px;
  cursor: pointer; border: 1px solid var(--wb-line); background: var(--wb-surface-hover); color: var(--wb-text);
  transition: background .15s, border-color .15s, color .15s, opacity .15s; }
.wb-btn:hover:not(:disabled) { background: var(--wb-accent-soft); border-color: var(--wb-accent); color: var(--wb-accent-strong); }
.wb-btn:focus-visible { outline: 2px solid var(--wb-accent); outline-offset: 1px; }
.wb-btn:disabled { opacity: .38; cursor: not-allowed; }
.wb-btn-primary { border-color: var(--wb-accent); background: var(--wb-accent); color: #fff; }
.wb-btn-primary:hover:not(:disabled) { background: var(--wb-accent-strong); border-color: var(--wb-accent-strong); color: #fff; }
.wb-btn-ghost { background: transparent; color: var(--wb-muted); }
.wb-btn-ghost:hover:not(:disabled) { background: var(--wb-accent-soft); color: var(--wb-accent-strong); }
.wb-btn-danger { border-color: rgba(229,72,77,.35); background: rgba(229,72,77,.07); color: #e5484d; }
.wb-btn-danger:hover:not(:disabled) { border-color: rgba(229,72,77,.6); background: rgba(229,72,77,.14); color: #e5484d; }

/* banners --------------------------------------------------------------- */
.wb-callout { margin: 0 16px 16px; padding: 12px 14px; border: 1px solid var(--wb-line); border-left: 3px solid var(--wb-accent);
  background: var(--wb-accent-soft); border-radius: 10px; font-size: 12.5px; line-height: 1.7; color: var(--wb-muted); }
.wb-callout-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.wb-callout code { flex: 1; min-width: 0; font-family: var(--wb-mono); font-size: 12px; color: var(--wb-text); word-break: break-all; }
.wb-error { margin: 0 0 16px; padding: 11px 14px; border: 1px solid rgba(229,72,77,.4); border-radius: 10px;
  background: rgba(229,72,77,.08); color: #e5484d; font-size: 12.5px; line-height: 1.65; }

/* models ---------------------------------------------------------------- */
.wb-section { border-top: 1px solid var(--wb-line-soft); }
.wb-section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; padding: 13px 16px 8px 26px; }
.wb-section-title { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--wb-muted); }
.wb-badge { font-size: 11.5px; line-height: 17px; padding: 0 7px; border-radius: 6px;
  background: var(--wb-surface-hover); color: var(--wb-muted); font-variant-numeric: tabular-nums; }
/* The summary numbers change as models are checked, so the strip that holds them
   keeps one width and the button after it never moves. */
.wb-availability { min-width: 178px; font-size: 12px; color: var(--wb-muted);
  font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The right-hand pair sits together at the end of the row: the icon action takes
   the free space, and its own padding is trimmed so the gap to the check button
   reads like the gap between the two bulk buttons below. */
.wb-section-head .wb-icon-btn { margin-left: auto; padding: 5px 4px; margin-right: -2px; }
/* The check button swaps its label while working; a fixed box keeps the refresh
   icon beside it from sliding. */
.wb-section-head .wb-btn { min-width: 96px; justify-content: center; }
.wb-tools { display: flex; align-items: center; gap: 8px; padding: 0 16px 12px; }
.wb-head-right { margin-left: auto; }
.wb-search { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 120px; }
.wb-search input { font: inherit; font-size: 12.5px; width: 100%; padding: 6px 10px; border-radius: 8px;
  border: 1px solid var(--wb-line); background: transparent; color: var(--wb-text); }
.wb-search input::placeholder { color: var(--wb-muted); }
.wb-search input:focus { outline: none; border-color: var(--wb-accent); }
.wb-search input:disabled { opacity: .45; cursor: not-allowed; }
/* legacy flat-list heading, superseded by the group cards */
.wb-model-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--wb-line); }
.wb-models-body { max-height: 380px; overflow: auto; padding: 4px 16px 10px; scrollbar-width: thin;
  /* Reserve the scrollbar's width always: without this the whole card narrows
     the moment the list starts scrolling. */
  scrollbar-gutter: stable;
  scrollbar-color: var(--wb-line) transparent; }
.wb-models-body::-webkit-scrollbar { width: 8px; }
.wb-models-body::-webkit-scrollbar-thumb { background: var(--wb-line); border-radius: 8px; }
.wb-models-body::-webkit-scrollbar-track { background: transparent; }
.wb-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 16px 10px; }
.wb-chip { font-family: var(--wb-mono); font-size: 11.5px; padding: 2px 9px; border-radius: 999px;
  border: 1px solid rgba(18,191,160,.4); background: var(--wb-accent-soft); color: var(--wb-accent-strong); }
/* Each group is a card of its own inside the model list card. */
.wb-group-card { border: 1px solid var(--wb-line-soft); border-radius: 12px; overflow: hidden;
  background: var(--wb-surface); }
.wb-group-card + .wb-group-card { margin-top: 10px; }
.wb-group-head { box-sizing: border-box; display: flex; align-items: center; gap: 8px;
  padding: 8px 12px 8px 10px; font-size: 12px; font-weight: 500; color: var(--wb-muted); cursor: pointer;
  background: var(--wb-surface-hover); border-bottom: 1px solid var(--wb-line-soft); }
.wb-group-head:hover { color: var(--wb-text); }
.wb-group-count { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 5px;
  background: var(--wb-surface); color: var(--wb-muted); font-variant-numeric: tabular-nums; }
/* One line per model, read left to right as caret · state · name · id · tags ·
   rate · switch. The rate keeps a fixed width and the switch a fixed slot, so
   every row lines up. */
.wb-model-block + .wb-model-block { border-top: 1px solid var(--wb-line-soft); }
.wb-model { box-sizing: border-box; display: flex; align-items: center; gap: 10px; min-height: 36px;
  padding: 6px 12px 6px 10px; font-size: 13px; cursor: pointer; transition: background .12s; }
.wb-model:hover { background: var(--wb-surface-hover); }
.wb-model-block-open > .wb-model { background: var(--wb-surface-hover); }
/* A drawn chevron: crisp at any zoom, and it matches the panel's icon weight. */
.wb-caret { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center;
  justify-content: center; color: var(--wb-muted); transition: transform .15s; }
.wb-caret svg { width: 11px; height: 11px; display: block; }
.wb-model-block-open > .wb-model .wb-caret,
.wb-group-head[aria-expanded="true"] .wb-caret { transform: rotate(90deg); }
.wb-model-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--wb-line); }
/* The name leads in a fixed-width column (so the ids line up under each other),
   and the id trails as a quieter annotation in the mono face. */
.wb-model-name { flex: none; width: 168px; font-size: 13px; font-weight: 500; color: var(--wb-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-model-rate { flex: none; min-width: 54px; text-align: right;
  font-family: var(--wb-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--wb-text); }
/* Tags inside the details: enums (modalities, levels, load) read better as tags. */
.wb-tags { display: inline-flex; flex-wrap: wrap; gap: 5px; }
.wb-tag { display: inline-block; padding: 0 6px; border-radius: 5px; font-size: 11px; line-height: 17px;
  background: var(--wb-surface-hover); color: var(--wb-text); }
.wb-tag-accent { background: var(--wb-accent-soft); color: var(--wb-accent-strong); }
.wb-model-off .wb-model-name, .wb-model-off .wb-model-rate { opacity: .45; }
.wb-model-detail { padding: 12px 14px 14px 38px; border-top: 1px dashed var(--wb-line-soft);
  display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px 48px; }
.wb-detail { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.65; min-width: 0; }
.wb-detail-wide { grid-column: 1 / -1; }
.wb-detail-label { flex: none; width: 74px; color: var(--wb-muted); white-space: nowrap; }
.wb-detail-value { color: var(--wb-text); word-break: break-word; }
/* The description reads as prose, so it is dimmer and wider than a field. */
.wb-detail-wide .wb-detail-value { color: var(--wb-muted); line-height: 1.75; max-width: 76ch; }
.wb-switch { flex: none; width: 30px; height: 17px; border-radius: 999px; padding: 0; cursor: pointer;
  border: 1px solid var(--wb-line); background: transparent; position: relative; transition: background .15s, border-color .15s; }
.wb-switch-knob { position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%;
  background: var(--wb-muted); transition: transform .15s, background .15s; }
.wb-switch-on { border-color: var(--wb-accent); background: var(--wb-accent-soft); }
.wb-switch-on .wb-switch-knob { transform: translateX(13px); background: var(--wb-accent-strong); }
.wb-switch:disabled { opacity: .4; cursor: not-allowed; }
/* One tag style everywhere: availability, promotion, load, free, and the enums
   inside a model's details all read as the same small pill.
   Tone carries the meaning — neutral, accent, ok, warn, bad. */
.wb-tag { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; line-height: 1.55; white-space: nowrap; background: var(--wb-surface-hover);
  color: var(--wb-muted); font-weight: 500; }
.wb-tag-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.wb-tag-accent { background: var(--wb-accent-soft); color: var(--wb-accent-strong); }
.wb-tag-ok { background: rgba(63,164,91,.14); color: #3fa45b; }
.wb-tag-warn { background: rgba(216,150,20,.15); color: #d89614; }
.wb-tag-bad { background: rgba(229,72,77,.13); color: #e5484d; }
/* The row's right-hand cluster: promotion, load, rate — one block, one baseline. */
.wb-model-tail { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
/* The load tag keeps one width in every state, so the cluster never shifts. */
.wb-busy-column { min-width: 68px; justify-content: center; }
.wb-skeleton-row { display: flex; align-items: center; gap: 10px; padding: 10px 16px; }
.wb-skeleton { height: 9px; border-radius: 5px; background: var(--wb-surface-hover); animation: wb-pulse 1.4s ease-in-out infinite; }
.wb-skeleton-a { width: 26%; }
.wb-skeleton-b { width: 18%; }
.wb-skeleton-c { width: 8%; margin-left: auto; }
@keyframes wb-pulse { 0%, 100% { opacity: .45 } 50% { opacity: .9 } }
.wb-empty { padding: 16px; text-align: center; font-size: 12.5px; color: var(--wb-muted); }
/* A loading line breathes a little, and reads one step larger than the muted
   captions around it so it is clearly a state, not a label. */
.wb-loading { font-size: 14px; color: var(--wb-muted); animation: wb-pulse 1.6s ease-in-out infinite; }
.wb-muted { color: var(--wb-muted); }
`

    /** The chevron every foldable row carries; it rotates through CSS. */
    const Caret = () => h('span', { className: 'wb-caret', 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4.5 2.5 L8 6 L4.5 9.5' })
      )
    )

    /**
     * The plugin's own artwork, served by the Host at `/workbuddy/icon-mask`.
     *
     * It is painted through a CSS mask rather than loaded as an image, so the
     * mark takes the panel's accent colour and stays legible in either theme
     * (the source file is a single-colour silhouette with the figure knocked out
     * of its alpha channel).
     */
    function Logomark() {
      return h('span', { className: 'wb-logo', 'aria-hidden': 'true' })
    }

    function statusColor(region) {
      if (region.pending) return { color: 'var(--dsw-alias-state-warn-primary, #d89614)' }
      if (region.loggedIn) return { color: 'var(--dsw-alias-state-success-primary, #3fa45b)' }
      if (region.expiresAt > 0) return { color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
      return { color: 'var(--dsw-alias-state-idle-primary, #8a8f98)' }
    }

    const formatTime = (ms, fallback) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toLocaleString() : fallback)
    const formatCredits = (value) => (typeof value === 'number' && Number.isFinite(value) ? (Number.isInteger(value) ? String(value) : value.toFixed(2)) : '—')
    /**
     * `credits` arrives as the server writes it (`"x0.00 credits"`, `"x2.20"`);
     * the official picker shows just the factor, so extract the number and put
     * an `x` after it.
     */
    const formatRate = (credits) => {
      if (typeof credits !== 'string') return null
      const factor = /(\d+(?:\.\d+)?)/.exec(credits)
      return factor === null ? credits : `${factor[1]}x`
    }
    /**
     * A zero rate reads as 「免费」 rather than 「0.00x」: that is the panel's own
     * vocabulary, and it is what the promotion block is advertising anyway.
     */
    const isFreeModel = (model) => {
      if (typeof model.credits !== 'string') return false
      const factor = /(\d+(?:\.\d+)?)/.exec(model.credits)
      return factor !== null && Number.parseFloat(factor[1]) === 0
    }

    /**
     * How a verdict reads in the list.
     *
     * Only three things are worth saying, and each maps to one colour:
     *
     * - `不可用` (red) — the gateway says the model id does not exist (`11102`).
     * - `无权限` (orange) — it exists, but this account may not use it: either
     *   the entitlement check refuses it (`11158`) or the request is judged an
     *   unapproved channel (`11128`, "被拦截").
     * - `未知` (grey) — anything else (upstream 5xx, credential trouble,
     *   a refused request shape). No conclusion can be drawn, so none is claimed;
     *   the raw detail stays in the tooltip.
     *
     * `ok` shows nothing, and an unprobed model shows nothing either, so the
     * list stays quiet where there is nothing to report.
     */
    /** `/v2/chat/busy` level → the label shown in a model's details. */
    const BUSY_LABEL = {
      idle: 'busyIdle',
      // The official client maps `normal` to the same label as `idle`; the two
      // server levels are indistinguishable to a user.
      normal: 'busyIdle',
      busy: 'busyBusy',
      congested: 'busyCongested'
    }

    /** Load tone: quiet green, loaded amber, congested red. */
    const busyTone = (level) => {
      if (level === 'idle' || level === 'normal') return 'wb-tag-ok'
      if (level === 'busy') return 'wb-tag-warn'
      if (level === 'congested') return 'wb-tag-bad'
      return ''
    }

    /** The word shown for one `/v2/chat/busy` level; absent or unknown reads 未知. */
    const busyLabel = (level, t) => (level === undefined || level === null || level === '' || level === 'unknown')
      ? t('unknown')
      : t(BUSY_LABEL[level] ?? 'busyUnknown')

    /**
     * The tooltip keeps the official phrasing, since the two-character labels
     * (`繁忙` / `拥堵`) deliberately drop the degree that the colour carries.
     */
    const busyTitle = (level, t) => {
      const official = level === 'busy' ? t('busyBusyOfficial')
        : level === 'congested' ? t('busyCongestedOfficial')
          : undefined
      const label = busyLabel(level, t)
      return official === undefined || official === label
        ? `${t('detailBusy')}：${label}`
        : `${t('detailBusy')}：${label}（${official}）`
    }

    /** One tag renderer, so availability, promotion, load and free all match. */
    const tag = (text, tone = '', extra = {}) => h('span', {
      className: `wb-tag${tone.length === 0 ? '' : ` ${tone}`}`,
      ...extra
    }, text)

    /**
     * The promotion's own tag: the deployment's label, tinted with the colour it
     * ships. Used both in the row and for 「促销类型」 in the details — the same
     * thing must not have two names.
     */
    const promotionTag = (promotion, t) => {
      const label = typeof promotion.label === 'string' && promotion.label.length > 0
        ? promotion.label
        : (promotion.kind === 'discount' ? t('promoDiscount') : promotion.kind)
      if (label === undefined) return null
      return tag(label, '', {
        title: promotion.text ?? label,
        ...(typeof promotion.color === 'string' && promotion.color.length > 0
          ? { style: { background: `${promotion.color}1f`, color: promotion.color } }
          : {})
      })
    }

    const AVAILABILITY_LABEL = {
      dead: 'stateDead',
      denied: 'stateDenied',
      blocked: 'stateDenied',
      down: 'stateUnknown',
      error: 'stateUnknown',
      auth: 'stateUnknown'
    }
    const availabilityChip = (entry, t) => {
      const key = entry === null || entry === undefined ? undefined : AVAILABILITY_LABEL[entry.state]
      if (key === undefined) return null
      const tone = entry.state === 'dead' ? 'wb-tag-bad'
        : ((entry.state === 'denied' || entry.state === 'blocked') ? 'wb-tag-warn' : '')
      return tag(t(key), tone, { key: 'state', title: availabilityTitle(entry, t) })
    }

    /** Dot color for a model's last verdict; unprobed models stay neutral. */
    const availabilityColor = (entry) => {
      if (entry === null || entry === undefined) return 'var(--wb-line)'
      if (entry.state === 'dead') return 'var(--dsw-alias-state-error-primary, #e5484d)'
      if (entry.state === 'denied' || entry.state === 'blocked' || entry.state === 'busy') {
        return 'var(--dsw-alias-state-warn-primary, #d89614)'
      }
      if (entry.state === 'ok') return 'var(--dsw-alias-state-success-primary, #3fa45b)'
      // Grey: no conclusion was reached, so no alarm is raised either.
      return 'var(--dsw-alias-state-idle-primary, #8a8f98)'
    }

    const availabilityTitle = (entry, t) => {
      if (entry === null || entry === undefined) return undefined
      const when = typeof entry.at === 'number' && entry.at > 0 ? ` · ${new Date(entry.at).toLocaleString()}` : ''
      return `${entry.detail ?? ''}${when}`.trim() || undefined
    }
    /** Local calendar day, matching the Host's bookkeeping key for claims. */
    const localDayKey = (now = new Date()) => {
      const pad = (value) => String(value).padStart(2, '0')
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    }

    async function request(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json', ...(options?.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...options
      })
      let json = {}
      try {
        json = await response.json()
      } catch {
        json = {}
      }
      if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`)
      return json
    }

    /**
     * Which tab to open: the first signed-in deployment in display order — the
     * mainland one comes first — so the panel opens on the same side the tab
     * strip starts on and the tab never moves once `/state` answers.
     */
    function defaultTab(regions) {
      const signedIn = regions.find((region) => region.loggedIn || region.pending)
      return (signedIn ?? regions[0])?.id ?? 'cn'
    }

    /**
     * Signed-out stand-ins: the card renders immediately with these while the
     * first `/state` answer is in flight, so the panel never shows a bare
     * "loading" page.
     *
     * The order must match the Host's (`REGION_IDS`): mainland first. A
     * placeholder list in a different order made the tabs swap places the moment
     * the real state arrived.
     */
    const PLACEHOLDER_REGIONS = [
      { id: 'cn', provider: 'workbuddy-cn', endpoint: 'https://www.workbuddy.cn', loggedIn: false, pending: false, nickname: '', expiresAt: 0, refreshable: false, models: 0, credits: null, checkin: null, lastClaim: null },
      { id: 'intl', provider: 'workbuddy-intl', endpoint: 'https://www.workbuddy.ai', loggedIn: false, pending: false, nickname: '', expiresAt: 0, refreshable: false, models: 0, credits: null, checkin: null, lastClaim: null }
    ]

    function WorkBuddySettings({ t }) {
      const [state, setState] = React.useState(null)
      // The first paint already shows the deployment the panel settles on, so the
      // tab does not jump from one side to the other once `/state` answers.
      const [activeId, setActiveId] = React.useState('cn')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [loginUrls, setLoginUrls] = React.useState({})
      const [copied, setCopied] = React.useState('')
      const [modelMap, setModelMap] = React.useState({})
      const [availability, setAvailability] = React.useState({})
      /** Which account's balance is being re-read right now. */
      const [creditBusy, setCreditBusy] = React.useState('')
      /** Model rows whose details are unfolded, keyed `region:model`. */
      const [expanded, setExpanded] = React.useState({})
      /** Group cards the user folded, keyed `region:group`; unusable starts folded. */
      const [folded, setFolded] = React.useState({})
      /** Busy levels per deployment, from `/v2/chat/busy` where it exists. */
      const [busyLevels, setBusyLevels] = React.useState({})
      /** Per-deployment model filter text; keeps each tab's search separate. */
      const [searches, setSearches] = React.useState({})
      const poll = React.useRef(null)
      const pinned = React.useRef(false)

      const load = React.useCallback(async () => {
        try {
          const next = await request('/state')
          setState(next)
          setError('')
          if (!pinned.current) setActiveId(defaultTab(next?.regions ?? []))
          // An authorization link is only worth showing while that deployment is
          // still waiting for one; once it is signed in the callout goes away
          // without needing a manual refresh.
          setLoginUrls((current) => {
            const regions = next?.regions ?? []
            const keep = Object.fromEntries(Object.entries(current)
              .filter(([id]) => regions.some((entry) => entry.id === id && entry.pending === true)))
            return Object.keys(keep).length === Object.keys(current).length ? current : keep
          })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => {
        void load()
        return () => {
          if (poll.current !== null) clearInterval(poll.current)
          poll.current = null
        }
      }, [load])

      const pending = state?.regions?.some((region) => region.pending) === true
      React.useEffect(() => {
        if (!pending) {
          if (poll.current !== null) clearInterval(poll.current)
          poll.current = null
          return undefined
        }
        if (poll.current === null) poll.current = setInterval(() => void load(), 2000)
        return () => {
          if (poll.current !== null) clearInterval(poll.current)
          poll.current = null
        }
      }, [pending, load])

      const loading = state === null
      const regions = state?.regions ?? PLACEHOLDER_REGIONS
      const region = regions.find((entry) => entry.id === activeId) ?? regions[0]
      const url = region === undefined ? undefined : loginUrls[region.id]

      const modelMeta = (result) => ({
        list: result.models ?? [],
        source: result.source,
        cachedAt: result.cachedAt,
        officialImportedAt: result.officialImportedAt
      })

      // Opening the panel is a good moment to check what still answers: the host
      // throttles it per deployment (China every 10 minutes, international daily),
      // so a re-render never turns into a burst of probes.
      const availabilityChecked = React.useRef({})
      React.useEffect(() => {
        const id = region?.id
        if (id === undefined || region?.loggedIn !== true) return
        if (availabilityChecked.current[id] === true) return
        availabilityChecked.current[id] = true
        void checkAvailability(id)
        void refreshBusy(id)
      }, [region?.id, region?.loggedIn])

      // The active account's models load on demand and stay for the session.
      const modelCount = region?.models ?? 0
      React.useEffect(() => {
        const id = region?.id
        if (id === undefined || region?.loggedIn !== true) return
        const cached = modelMap[id]
        if (cached !== undefined && (cached.loading === true || cached.list?.length === modelCount)) return
        setModelMap((current) => ({ ...current, [id]: { loading: true } }))
        void request(`/models?region=${encodeURIComponent(id)}`)
          .then((result) => setModelMap((current) => ({ ...current, [id]: modelMeta(result) })))
          .catch((cause) => setModelMap((current) => ({ ...current, [id]: { error: cause instanceof Error ? cause.message : String(cause) } })))
      }, [region?.id, region?.loggedIn, modelCount])

      // Actions that can change which models exist. Anything else (credits refresh,
      // check-in, availability probe) must not drop the cached list: the models effect
      // only re-runs when the region id, the login state or the model count changes, so
      // clearing on an unrelated action left the table on its loading skeleton until the
      // panel was reopened.
      const CLEARS_MODELS = new Set(['/enabled', '/import', '/login', '/logout', '/models'])

      const act = async (key, path, body) => {
        setBusy(key)
        setError('')
        try {
          const result = await request(path, { method: 'POST', body: JSON.stringify(body) })
          if (typeof result?.url === 'string' && result.url.length > 0) {
            setLoginUrls((current) => ({ ...current, [body.region]: result.url }))
          }
          if (body?.region !== undefined && CLEARS_MODELS.has(path)) setModelMap((current) => ({ ...current, [body.region]: undefined }))
          await load()
          // The host reports a failed write instead of throwing, so an unchecked
          // `saved: false` reads as success and the user keeps a setting that was never
          // stored.
          if (result?.saved === false) {
            setError(result.message ?? t('saveFailed'))
            return undefined
          }
          // Signing out (or finishing a switch) makes any pending link stale, so
          // the callout follows the state rather than lingering on screen.
          if (body?.region !== undefined && path === '/logout') {
            setLoginUrls((current) => {
              const next = { ...current }
              delete next[body.region]
              return next
            })
          }
          return result
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          return undefined
        } finally {
          setBusy('')
        }
      }

      const copy = async (regionId, value) => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(regionId)
          window.setTimeout(() => setCopied(''), 1500)
        } catch {
          setError(value)
        }
      }

      /** Ask the Host to re-read the catalog (scoped → config → cache). */
      const refreshModels = async (regionId) => {
        setModelMap((current) => ({ ...current, [regionId]: { loading: true } }))
        try {
          const result = await request(`/models?region=${encodeURIComponent(regionId)}&refresh=1`)
          setModelMap((current) => ({ ...current, [regionId]: modelMeta(result) }))
          await load()
        } catch (cause) {
          setModelMap((current) => ({ ...current, [regionId]: { error: cause instanceof Error ? cause.message : String(cause) } }))
        }
      }

      /**
       * Ask the Host to probe the catalog for models that actually answer. The
       * sweep can shrink the list (a probe that returns 11102 marks the model
       * dead), so the rows are re-read afterwards.
       */
      /** Busy levels for one deployment; empty on the side that has no such route. */
      const refreshBusy = async (regionId) => {
        try {
          const result = await request(`/busy?region=${encodeURIComponent(regionId)}`)
          setBusyLevels((current) => ({ ...current, [regionId]: result.levels ?? {} }))
        } catch {
          // A missing route is not an error worth showing: the detail row simply
          // stays absent.
        }
      }

      const checkAvailability = async (regionId, manual = false) => {
        setBusy(`availability:${regionId}`)
        setError('')
        try {
          // The button asks for a sweep; opening the panel only lets the host
          // decide (China runs it every time, the international one daily).
          const result = await request(`/availability?region=${encodeURIComponent(regionId)}&refresh=1${manual ? '&manual=1' : ''}`)
          setAvailability((current) => ({ ...current, [regionId]: { counts: result.counts ?? {}, total: result.total ?? 0, savedAt: result.savedAt ?? 0 } }))
          const models = await request(`/models?region=${encodeURIComponent(regionId)}`)
          setModelMap((current) => ({ ...current, [regionId]: modelMeta(models) }))
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy('')
        }
      }

      /** Re-read just one account's balance, leaving the rest of the panel alone. */
      const refreshCredits = async (regionId) => {
        setCreditBusy(regionId)
        setError('')
        try {
          const result = await request(`/credits?region=${encodeURIComponent(regionId)}`)
          setState((current) => current === null ? current : {
            ...current,
            regions: current.regions.map((entry) => entry.id === regionId ? { ...entry, credits: result.credits ?? null } : entry)
          })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setCreditBusy('')
        }
      }

      /**
       * Open the deployment's official plans page in the user's browser.
       *
       * The host resolves the URL from its own allowlist, so the panel only ever
       * names a page. When launching fails the reply still carries the URL and
       * the panel shows it, rather than pretending nothing happened.
       */
      const openPlans = async (regionId) => {
        setError('')
        try {
          const result = await request('/open', { method: 'POST', body: JSON.stringify({ region: regionId, page: 'plans' }) })
          if (result.opened !== true && typeof result.url === 'string') {
            setError(t('openPlansFailed')(result.url))
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }

      const credits = region?.credits
      const checkin = region?.checkin
      const models = region === undefined ? undefined : modelMap[region.id]

      // The status endpoint and the claim endpoint disagree while an activity
      // is winding down (status says "not checked in", the claim answers
      // 10001), so a claim recorded for today also counts as checked in.
      const lastClaim = region?.lastClaim
      const claimedToday = lastClaim !== null && lastClaim !== undefined &&
        lastClaim.day === localDayKey() && (lastClaim.claimed === true || lastClaim.already === true)

      const modelsLoading = region?.loggedIn === true && (models === undefined || models.loading === true)
      const query = searches[region?.id ?? ''] ?? ''
      const rows = (models?.list ?? []).filter((model) => {
        if (query.length === 0) return true
        const needle = query.toLowerCase()
        return model.id.toLowerCase().includes(needle) ||
          String(model.name ?? '').toLowerCase().includes(needle) ||
          String(model.description ?? '').toLowerCase().includes(needle)
      })
      // Grouped strictly by what the probe found. Only a missing model (`11102`)
      // and a permission refusal (`11158`, `11128`) count as unusable; the
      // transient and unexplained states stay in the usable group with a grey
      // `未知` chip, because nothing has been proven about them.
      const unusableState = (model) => {
        const state = model.availability?.state
        return state === 'dead' || state === 'denied' || state === 'blocked'
      }
      const presets = rows.filter((model) => model.preset === true)
      // Everything the bulk buttons may act on: real models, not router presets.
      const usableRows = rows.filter((model) => model.preset !== true)
      // Listed by display name (falling back to the id), the way the official
      // picker orders them, and carrying the busy level the deployment reports.
      const byName = (a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), 'zh-Hans-CN', { numeric: true })
      // Both the level and whether this deployment even publishes one: the
      // international build has no `/v2/chat/busy`, so it shows nothing at all
      // there instead of a column of "未知".
      const withBusy = (model) => ({
        ...model,
        busy: busyLevels[region?.id ?? '']?.[model.id],
        busyKnown: region?.hasBusy === true
      })
      const usable = usableRows.filter((model) => !unusableState(model)).map(withBusy).sort(byName)
      const unusable = usableRows.filter(unusableState).map(withBusy).sort(byName)

      /** The pill beside the deployment name: one state, one word. */
      const statusLabel = (entry) => {
        if (entry.pending) return { text: t('statusPending'), token: 'var(--dsw-alias-state-warn-primary, #d89614)' }
        if (entry.loggedIn) return { text: t('statusLoggedIn'), token: 'var(--dsw-alias-state-success-primary, #3fa45b)' }
        if (entry.expiresAt > 0) return { text: t('statusExpired'), token: 'var(--dsw-alias-state-error-primary, #e5484d)' }
        return { text: t('statusLoggedOut'), token: 'var(--dsw-alias-state-idle-primary, #8a8f98)' }
      }

      /** Turn one model, a group, or every row on/off; `reset` returns to the verdict default. */
      const setModelsEnabled = async (regionId, ids, enabled, reset = false) => {
        if (ids.length === 0) return
        setBusy(`enabled:${regionId}`)
        setError('')
        try {
          await request('/enabled', { method: 'POST', body: JSON.stringify({ region: regionId, ids, enabled, reset }) })
          const result = await request(`/models?region=${encodeURIComponent(regionId)}`)
          setModelMap((current) => ({ ...current, [regionId]: modelMeta(result) }))
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy('')
        }
      }

      /** The per-row switch: on means the harness may offer this model. */
      const enableSwitch = (model, regionId) => h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': model.enabled !== false,
        className: model.enabled === false ? 'wb-switch' : 'wb-switch wb-switch-on',
        title: model.enabled === false ? t('enableModel') : t('disableModel'),
        disabled: busy === `enabled:${regionId}`,
        onClick: (event) => {
          event.stopPropagation()
          void setModelsEnabled(regionId, [model.id], model.enabled === false)
        }
      }, h('span', { className: 'wb-switch-knob' }))

      /**
       * Everything the panel knows about one model, description first. Only
       * fields that actually arrived are listed: a missing one is not shown as
       * "unknown" here, because the row's own columns already say that. The
       * availability verdict is deliberately absent — the dot beside the name is
       * the whole story, and the raw text lives in its tooltip.
       */
      /** A small tag, used where the value is a short enum rather than prose. */
      const detailTag = (text, tone = '') => tag(text, tone.trim())

      const modelDetails = (model) => {
        const rows = []
        const add = (label, value, wide = false) => {
          if (value === undefined || value === null || value === '') return
          rows.push(h('div', { className: wide ? 'wb-detail wb-detail-wide' : 'wb-detail', key: label },
            h('span', { className: 'wb-detail-label' }, label),
            h('span', { className: 'wb-detail-value' }, value)
          ))
        }
        const formatTokens = (value) => (typeof value === 'number'
          ? (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))
          : undefined)
        const promotion = model.promotion
        add(t('detailDescription'), model.description, true)
        add(t('detailId'), model.id)
        add(t('detailContext'), formatTokens(model.contextWindow))
        add(t('detailMaxOutput'), formatTokens(model.maxTokens))
        // Enum-ish values read better as tags than as a slash-joined string.
        add(t('detailModality'), Array.isArray(model.input)
          ? h('span', { className: 'wb-tags' }, model.input.map((modality) =>
            detailTag(t(modality === 'image' ? 'modalityImage' : 'modalityText'), ' wb-tag-accent')))
          : undefined)
        add(t('detailEfforts'), model.efforts.length === 0
          ? undefined
          : h('span', { className: 'wb-tags' }, model.efforts.map((level) => detailTag(level))))
        add(t('detailRate'), model.credits === undefined
          ? t('unknown')
          : (isFreeModel(model) ? detailTag(t('freeModel'), ' wb-tag-accent') : (formatRate(model.credits) ?? model.credits)))
        // Busy sits with the live facts, above the promotion block. It is only
        // meaningful where the deployment reports it; a level the service does not
        // track reads 「未知」 rather than disappearing.
        add(t('detailBusy'), model.busyKnown !== true
          ? undefined
          // Every load state — 「未知」 included — renders as the same tag in the
          // same fixed-width column, so the row does not shift between states.
          : h('span', {
            className: `wb-tag wb-busy-column ${busyTone(model.busy)}`,
            title: busyTitle(model.busy, t)
          },
          h('span', { className: 'wb-tag-dot' }),
          busyLabel(model.busy, t)))
        // The promotion is split into what it is, how long it lasts and what it
        // says, because those three answer different questions. The kind shows
        // the *same tag* the row does (`Free now` and friends), so the two never
        // disagree about what the promotion is called.
        add(t('detailPromoKind'), promotion === undefined ? undefined : promotionTag(promotion, t))
        add(t('detailPromoWindow'), promotion === undefined
          ? undefined
          : [promotion.from, promotion.until]
            .map((value) => (typeof value === 'string' ? formatTime(Date.parse(value), t('unknown')) : undefined))
            .filter(Boolean).join(' → ') || undefined)
        add(t('detailPromoText'), promotion?.text, true)
        return h('div', { className: 'wb-model-detail' }, rows)
      }

      const modelRow = (model, regionId) => {
        const key = `${regionId}:${model.id}`
        const open = expanded[key] === true
        return h('div', { key: model.id, className: open ? 'wb-model-block wb-model-block-open' : 'wb-model-block' },
          h('div', {
            className: model.enabled === false ? 'wb-model wb-model-off' : 'wb-model',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            title: model.description ?? model.id,
            onClick: () => setExpanded((current) => ({ ...current, [key]: current[key] !== true })),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setExpanded((current) => ({ ...current, [key]: current[key] !== true }))
            }
          },
          h(Caret, null),
          h('span', {
            className: 'wb-model-dot',
            style: { background: availabilityColor(model.availability) },
            title: availabilityTitle(model.availability, t)
          }),
          h('span', { className: 'wb-model-name' }, model.name ?? model.id),
          // The right-hand cluster reads as one block: what it costs (promotion),
          // how loaded it is, the rate itself — then the switch, which is the only
          // control in the row.
          h('span', { className: 'wb-model-tail' },
            availabilityChip(model.availability, t),
            model.promotion === undefined ? null : promotionTag(model.promotion, t),
            model.busyKnown !== true
              ? null
              : tag([
                h('span', { className: 'wb-tag-dot', key: 'dot' }),
                busyLabel(model.busy, t)
              ], `wb-busy-column ${busyTone(model.busy)}`, {
                key: 'busy',
                // The tooltip keeps the official phrasing (轻微拥堵 / 极度拥堵).
                title: busyTitle(model.busy, t)
              }),
            h('span', { className: 'wb-model-rate', title: t('creditsRate') },
              model.credits === undefined
                ? h('span', { className: 'wb-muted' }, t('unknown'))
                : (isFreeModel(model)
                  ? tag(t('freeModel'), 'wb-tag-accent', { style: { fontFamily: 'inherit' } })
                  : (formatRate(model.credits) ?? t('unknown'))))
          ),
          enableSwitch(model, regionId)
          ),
          open ? modelDetails(model) : null
        )
      }

      /**
       * A group is its own collapsible card inside the model card; bulk switching
       * lives in the toolbar. The unusable group starts folded: it is the part
       * that is usually not wanted.
       */
      const group = (label, list, key, regionId) => list.length === 0 ? null : (() => {
        const foldKey = `${regionId}:${key}`
        const collapsed = folded[foldKey] ?? (key === 'unusable')
        return h('div', { className: 'wb-group-card', key },
          h('div', {
            className: 'wb-group-head',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': collapsed !== true,
            onClick: () => setFolded((current) => ({ ...current, [foldKey]: current[foldKey] === undefined ? !(key === 'unusable') : !current[foldKey] })),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setFolded((current) => ({ ...current, [foldKey]: current[foldKey] === undefined ? !(key === 'unusable') : !current[foldKey] }))
            }
          },
          h(Caret, null),
          h('span', null, label),
          h('span', { className: 'wb-group-count' }, String(list.length))
          ),
          collapsed === true ? null : list.map((model) => modelRow(model, regionId))
        )
      })()

      const skeleton = () => h('div', null, [0, 1, 2].map((index) => h('div', { key: index, className: 'wb-skeleton-row' },
        h('span', { className: 'wb-skeleton wb-skeleton-a' }),
        h('span', { className: 'wb-skeleton wb-skeleton-b' }),
        h('span', { className: 'wb-skeleton wb-skeleton-c' })
      )))

      /**
       * The account table, transposed: deployments are the columns and the
       * fields are the rows, so both accounts read side by side.
       *
       * It is one CSS grid rather than a grid per row, which lets a signed-out
       * deployment take its whole column with a single centred sign-in button
       * instead of four rows of "未知" and disabled controls.
       */
      const ACCOUNT_FIELDS = [t('colAccount'), t('colExpires'), t('colCredits'), t('colActions')]
      const accountGrid = () => {
        const cells = []
        cells.push(h('span', { className: 'wb-row-label', key: 'head', style: { gridRow: 1, gridColumn: 1 } }, t('colDeploy')))
        ACCOUNT_FIELDS.forEach((label, index) => cells.push(h('span', {
          className: 'wb-row-label',
          key: `label-${label}`,
          style: { gridRow: index + 2, gridColumn: 1 }
        }, label)))

        regions.forEach((entry, index) => {
          const column = index + 2
          const status = statusLabel(entry)
          cells.push(h('div', {
            className: 'wb-th wb-deploy',
            key: `head-${entry.id}`,
            style: { gridRow: 1, gridColumn: column },
            title: `${entry.provider} · ${entry.endpoint}`
          },
          h('span', { className: 'wb-deploy-dot', style: { background: status.token }, title: status.text }),
          h('span', null, t(entry.id === 'cn' ? 'regionCn' : 'regionIntl')),
          // The daily claim lives beside the deployment name: the balance row has
          // to stay narrow (a top-up makes that number longer), and only one
          // deployment has this action anyway.
          checkinButton(entry)
          ))

          if (entry.loggedIn !== true) {
            cells.push(h('div', {
              className: 'wb-td wb-td-span',
              key: `signin-${entry.id}`,
              style: { gridRow: `2 / span ${ACCOUNT_FIELDS.length}`, gridColumn: column }
            },
            // Before the first answer arrives we do not know whether this account
            // is signed in, so the cell says so instead of offering a sign-in
            // button that may be pointless a moment later.
            loading
              ? h('span', { className: 'wb-loading' }, t('loading'))
              : h('button', {
                type: 'button',
                className: 'wb-btn wb-btn-primary',
                disabled: busy === `login:${entry.id}` || entry.pending,
                onClick: () => void act(`login:${entry.id}`, '/login', { region: entry.id })
              }, entry.pending ? t('loggingIn') : t('login'))
            ))
            return
          }

          const last = ACCOUNT_FIELDS.length - 1
          const cell = (row, key, children, extra = '') => h('div', {
            className: `wb-td${row === last ? ' wb-td-last' : ''}${extra.length === 0 ? '' : ` ${extra}`}`,
            key: `${key}-${entry.id}`,
            style: { gridRow: row + 2, gridColumn: column }
          }, children)

          cells.push(cell(0, 'account', h('span', { className: 'wb-account-name' },
            entry.nickname.length > 0 ? entry.nickname : t('unknown'))))
          cells.push(cell(1, 'expires', h('span', { className: 'wb-num' }, formatTime(entry.expiresAt, t('unknown')))))
          cells.push(cell(2, 'credits', [
            entry.credits !== null && entry.credits !== undefined && entry.credits.ok === true
              ? h('span', { key: 'value', className: 'wb-credits-value' }, formatCredits(entry.credits.total))
              : h('span', { key: 'value', className: 'wb-muted' }, t('unknown')),
            // All values share a left edge; the quiet balance actions follow
            // the figure directly so each deployment reads as one compact group.
            h('span', { key: 'actions', className: 'wb-cell-actions' }, [
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'wb-icon-btn',
                title: t('refreshCredits'),
                'aria-label': t('refreshCredits'),
                disabled: creditBusy === entry.id,
                onClick: () => void refreshCredits(entry.id)
              }, creditBusy === entry.id ? '…' : '⟳'),
              // The official plans page needs the deployment's own signed-in
              // session, so it opens in the user's browser rather than in here.
              h('button', {
                key: 'plans',
                type: 'button',
                className: 'wb-link-btn',
                title: t('openPlansHint'),
                onClick: () => void openPlans(entry.id)
              }, t('openPlans'))
            ])
          ], 'wb-td-credits'))
          cells.push(cell(3, 'actions', accountActions(entry)))
        })
        return cells
      }

      const checkinButton = (entry) => {
        const rowCheckin = entry.checkin
        if (rowCheckin?.supported !== true || rowCheckin.ok !== true) return null
        const claimedToday = entry.lastClaim !== null && entry.lastClaim !== undefined &&
          entry.lastClaim.day === localDayKey() &&
          (entry.lastClaim.claimed === true || entry.lastClaim.already === true)
        const checkedIn = rowCheckin.todayCheckedIn === true || claimedToday
        return h('button', {
          type: 'button',
          className: 'wb-btn',
          disabled: busy === `checkin:${entry.id}` || !entry.loggedIn || checkedIn || !rowCheckin.active,
          // The automatic claim is the normal path, so its outcome lives in the
          // tooltip rather than in a table row of its own.
          title: entry.lastClaim?.claimed === true
            ? t('lastClaim')(formatTime(entry.lastClaim.at, t('unknown')), t('claimResult')(entry.lastClaim.credit ?? 0))
            : undefined,
          onClick: () => void act(`checkin:${entry.id}`, '/checkin', { region: entry.id })
        }, busy === `checkin:${entry.id}` ? t('claiming') : (checkedIn ? t('checkedIn') : t('claim')))
      }

      const accountActions = (entry) => [
        h('button', {
          key: 'login',
          type: 'button',
          className: 'wb-btn wb-btn-primary',
          disabled: busy === `login:${entry.id}` || entry.pending,
          onClick: () => void act(`login:${entry.id}`, '/login', { region: entry.id })
        }, entry.pending ? t('loggingIn') : (entry.loggedIn ? t('switchAccount') : t('login'))),
        h('button', {
          key: 'logout',
          type: 'button',
          className: 'wb-btn wb-btn-danger',
          disabled: busy === `logout:${entry.id}` || (!entry.loggedIn && entry.expiresAt === 0),
          onClick: () => void act(`logout:${entry.id}`, '/logout', { region: entry.id })
        }, t('logout'))
      ]

      /**
       * Renew both deployments from one button in the card corner: the tokens are
       * independent, so this is just the single-deployment refresh run per region,
       * signed-in ones only.
       */
      const renewAll = async () => {
        setBusy('renew:all')
        setError('')
        try {
          for (const entry of regions) {
            if (entry.loggedIn !== true) continue
            await request('/refresh', { method: 'POST', body: JSON.stringify({ region: entry.id }) })
          }
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy('')
        }
      }

      /** The pending sign-in link, shown inside the account card. */
      const loginCallout = () => {
        const pendingRegion = regions.find((entry) => loginUrls[entry.id] !== undefined || entry.pending)
        if (pendingRegion === undefined) return null
        const pendingUrl = loginUrls[pendingRegion.id]
        return h('div', { className: 'wb-callout' },
          t('loginHint'),
          pendingUrl === undefined ? null : h('div', { className: 'wb-callout-row' },
            h('code', null, pendingUrl),
            h('button', { type: 'button', className: 'wb-btn', onClick: () => void copy(pendingRegion.id, pendingUrl) },
              copied === pendingRegion.id ? t('copied') : t('copy'))
          )
        )
      }

      return h('section', { className: 'wb-root', 'aria-label': t('title') },
        h('style', null, CSS),
        h('h2', { className: 'wb-title' }, t('title')),
        h('p', { className: 'wb-intro' }, t('intro')),
        error.length > 0 ? h('p', { className: 'wb-error', role: 'alert' }, error) : null,

        // Cards are separate concerns: who is signed in, and what they can run.
        h('div', { className: 'wb-card wb-account-card' },
          h('div', { className: 'wb-card-head' },
            h(Logomark, null),
            h('span', { className: 'wb-card-title' }, t('cardAccounts')),
            loading ? h('span', { className: 'wb-loading' }, t('loading')) : null,
            // One renewal for both deployments, kept out of the per-account actions
            // because it is never about just one of them.
            h('div', { className: 'wb-head-right' },
              h('button', {
                type: 'button',
                className: 'wb-btn',
                disabled: busy === 'renew:all' || regions.every((entry) => entry.loggedIn !== true),
                title: t('renewBothHint'),
                onClick: () => void renewAll()
              }, busy === 'renew:all' ? t('renewing') : t('renewBoth'))
            )
          ),
          h('div', {
            // A single separator stays at the card's centre when there are
            // exactly two deployments.
            className: regions.length === 2 ? 'wb-table wb-table-split' : 'wb-table',
            role: 'table',
            style: { '--wb-cols': String(Math.max(1, regions.length)) }
          }, accountGrid()),
          loginCallout()
        ),

        region === undefined ? null : h('div', { className: 'wb-card' },
          h('div', { className: 'wb-tabs', role: 'tablist' },
            regions.map((entry) => h('button', {
              key: entry.id,
              type: 'button',
              role: 'tab',
              'aria-selected': entry.id === region.id,
              className: entry.id === region.id ? 'wb-tab wb-tab-on' : 'wb-tab',
              onClick: () => {
                pinned.current = true
                setActiveId(entry.id)
              }
            },
            h('span', { className: 'wb-tab-dot', style: statusColor(entry) }),
            t(entry.id === 'cn' ? 'regionCn' : 'regionIntl'),
            entry.loggedIn && entry.nickname.length > 0 ? h('span', { className: 'wb-tab-sub' }, entry.nickname) : null
            ))
          ),
          // Two rows: what this list is, then the tools that act on it. Every
          // control is always present — signed out or still loading they show
          // zeros and sit disabled, so the card keeps its shape instead of
          // growing a toolbar once the models arrive.
          h('div', { className: 'wb-section-head' },
            h('span', { className: 'wb-section-title' }, t('models')),
            h('span', { className: 'wb-badge' }, t('count')(region.models ?? 0)),
            models?.source === 'none'
              ? h('span', { className: 'wb-muted' }, t('catalogUnavailable'))
              : models?.source === 'cache'
                ? h('span', { className: 'wb-muted' }, `${t('catalogCache')}${models.cachedAt ? ` ${formatTime(models.cachedAt, '')}` : ''}`)
                : null,
            h('span', { className: 'wb-availability' },
              t('availabilityResult')(availability[region.id]?.counts?.ok ?? 0, availability[region.id]?.counts?.dead ?? 0)),
            h('button', {
              key: 'refresh-list',
              type: 'button',
              className: 'wb-icon-btn',
              title: t('refreshList'),
              'aria-label': t('refreshList'),
              disabled: models?.loading === true || region.loggedIn !== true,
              onClick: () => void refreshModels(region.id)
            }, models?.loading === true ? '…' : '⟳'),
            h('button', {
              key: 'check-availability',
              type: 'button',
              className: 'wb-btn wb-btn-ghost',
              disabled: busy === `availability:${region.id}` || region.loggedIn !== true,
              onClick: () => void checkAvailability(region.id, true),
              title: t('availabilityHint')
            }, busy === `availability:${region.id}` ? t('checking') : t('checkAvailability'))
          ),
          h('div', { className: 'wb-tools' },
            h('span', { className: 'wb-search' },
              h('input', {
                type: 'search',
                value: query,
                placeholder: t('search'),
                'aria-label': t('search'),
                // Keyed on what the region *has*, not on what the query matched: with
                // the filtered list a zero-match search disabled its own input and the
                // only way out was closing the panel.
                disabled: (models?.list ?? []).length === 0,
                onChange: (event) => setSearches((current) => ({ ...current, [region.id]: event.target.value }))
              })),
            h('button', {
              key: 'enable-all',
              type: 'button',
              className: 'wb-btn wb-btn-ghost',
              // Only the usable group: the unusable one is the user's own call,
              // and a bulk switch there would fight the verdict defaults.
              disabled: busy === `enabled:${region.id}` || usable.length === 0,
              title: t('enableAllHint'),
              onClick: () => void setModelsEnabled(region.id, usable.map((model) => model.id), true)
            }, t('enableAll')),
            h('button', {
              key: 'disable-all',
              type: 'button',
              className: 'wb-btn wb-btn-ghost',
              disabled: busy === `enabled:${region.id}` || usable.length === 0,
              title: t('disableAllHint'),
              onClick: () => void setModelsEnabled(region.id, usable.map((model) => model.id), false)
            }, t('disableAll'))
          ),
          region.loggedIn !== true
            ? h('div', { className: 'wb-empty' }, t('noModels'))
            : modelsLoading
              ? skeleton()
              : models?.error !== undefined
                ? h('div', { className: 'wb-error', style: { margin: '0 16px 16px' } }, models.error)
                : (models?.list ?? []).length === 0
                  ? h('div', { className: 'wb-empty' }, models?.source === 'none' ? t('catalogUnavailable') : t('emptyModels'))
                  : rows.length === 0
                    ? h('div', { className: 'wb-empty' }, t('noMatch')(query))
                    : h('div', { className: 'wb-models-body' },
                      presets.length === 0 ? null : h('div', { className: 'wb-chips' },
                        presets.map((model) => h('span', { key: model.id, className: 'wb-chip', title: model.name ?? model.id }, model.id))),
                      group(t('groupUsable'), usable, 'usable', region.id),
                      group(t('groupUnusable'), unusable, 'unusable', region.id)
                    )
        )
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // A throwing apply() would leave the slot silently empty, so every
        // optional client service is probed and the whole registration is
        // contained; a failure is reported to the host log via the beacon.
        try {
          const get = typeof ctx.get === 'function' ? ctx.get.bind(ctx) : () => undefined
          const locale = get('locale')
          /**
           * Translate through the host's locale service, but never let a missing
           * key leak into the UI.
           *
           * The service keeps the dictionary it was first given, so a hot-reloaded
           * client asking for a key added since then gets the key itself back
           * (which is how `renewBoth` once appeared as a button label). Falling
           * back to this bundle's own copy keeps new strings working without an
           * app restart.
           */
          const localise = (localeId, key) => {
            const value = dictFor(localeId)[key]
            return typeof value === 'function' ? value : value
          }
          const boundT = locale !== undefined && typeof locale.bind === 'function' ? locale.bind('workbuddy') : null
          const currentLocale = locale !== undefined && typeof locale.getLocale === 'function'
            ? String(locale.getLocale().locale ?? 'zh-CN')
            : 'zh-CN'
          // Keys holding a function (those taking arguments) are returned as the
          // function, exactly as the locale service returns them, so callers keep
          // using `t('count')(7)`.
          const t = (key) => {
            if (boundT !== null) {
              const fromService = boundT(key)
              if (fromService !== undefined && fromService !== key) return fromService
            }
            const local = localise(currentLocale, key)
            return local === undefined ? key : local
          }

          if (locale !== undefined && typeof locale.register === 'function' && typeof locale.getLocale === 'function') {
            const registered = []
            for (const entry of locale.getLocale().locales) {
              registered.push(locale.register('workbuddy', entry.id, dictFor(entry.id)))
            }
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => () => {
                for (const dispose of registered) dispose()
              }, 'dsh-workbuddy: locale dictionaries')
            }
          }

          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'workbuddy',
            order: 16,
            label: () => t('section')
          }, (props) => h(WorkBuddySettings, { ...props, t })))
          report('applied')
        } catch (failure) {
          report(`apply-failed: ${failure instanceof Error ? failure.message : String(failure)}`)
        }
      }
    }
  }
})
