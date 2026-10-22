# dsh-workbuddy

<img src="icon.webp" alt="" width="72" align="right">

WorkBuddy 模型接入插件（DeepSeek Harness / DSH），同时支持两个部署：

| Provider 路由    | 部署                      | 登录 `platform` |
| ---------------- | ------------------------- | --------------- |
| `workbuddy-intl` | https://www.workbuddy.ai  | `workbuddy-ai`  |
| `workbuddy-cn`   | https://www.workbuddy.cn  | `workbuddy`     |

> 接口、字段、错误码、指纹规则与实测记录都整理在 [`docs/workbuddy-protocol.md`](docs/workbuddy-protocol.md)，排障或二次开发先看那份。
> 要改这个仓库（人或 agent）先读 [`AGENTS.md`](AGENTS.md)。

> **非官方项目。** 本项目与腾讯 / WorkBuddy 官方无任何关联，不使用其商标授权，也不分发其代码；
> 它只是一个第三方客户端插件，按公开可观测的接口工作。请自行确认使用方式符合你所在地区的法律
> 与 WorkBuddy 的服务条款。仓库里不含任何真实账号数据——示例与截图一律是假数据。

## 安装

```sh
# 从 npm 安装到某个 profile（会同时把 bundle 挂进该 profile）
dsh plugin --profile <profile> add @huai_xin/dsh-workbuddy

# 直接从 GitHub 安装（npm 版本还没跟上改动时用它）
dsh plugin --profile <profile> add github:2424830124/dsh-workbuddy

# 本地目录（开发时）
dsh plugin --profile <profile> add /path/to/dsh-workbuddy
```

npm 页面：<https://www.npmjs.com/package/@huai_xin/dsh-workbuddy>

也可以在 Web UI 的插件管理里安装（效果相同，都是往 profile 的依赖里加一条并应用 patch）。

安装后需要重启 DSH（替换已加载的 JS 模块需要新的 generation），随后 `/workbuddy` 命令即可使用。

## 使用

### 设置页

界面长什么样、每块显示什么，见下面的 [设置面板](#设置面板) 一节（含截图）。

面板通过宿主路由 `/workbuddy/{state,login,logout,refresh,models,checkin,availability,credits,busy,enabled,import}` 读写状态，这些路由走与宿主一致的连接信任栅栏，只对本机已被 GUI 接纳的来源开放。

积分与签到：

- 软件启动约 15 秒后自动签到一次；此后每天**本地 0 点**再签到一次
- 签到是幂等的：服务端今天已领过会返回 `code 10001`，所以重启不会重复发积分
- 登录成功后也会立刻补一次签到
- 海外版后端没有签到接口，只显示积分、不显示领取按钮

### 命令

```
/workbuddy login cn        # 打开大陆版授权页面
/workbuddy login intl      # 海外版
/workbuddy login all       # 两个都登录
/workbuddy status          # 查看账号与到期时间
/workbuddy models cn       # 查看该账号当前可用的实时模型目录
/workbuddy refresh cn      # 强制续期
/workbuddy logout cn       # 清除凭据
```

登录完成后，在常规的模型选择器里选择 WorkBuddy 的模型即可。

## 工作原理

插件实现了 WorkBuddy 官方客户端的插件登录协议，并把两个部署各注册成一条 llm provider 路由：

- `POST /v2/plugin/auth/state?platform=…` → `{ state, authUrl }`
- `GET  /v2/plugin/auth/token?state=…` → access/refresh token
- `GET  /v2/plugin/login/account?state=…` → 账号信息
- `POST /v2/plugin/auth/token/refresh` → 令牌轮换（启动后 + 每 6 小时，且距过期不足 24 小时时）
- `GET  /console/enterprises/personal/models` → 实时模型目录（首选）
- `GET  /v3/config` → 实时模型目录（scoped 不可用时的回退：大陆版对插件令牌返回 `code 12403`，海外版 scoped 自 2026-10-21 起返回 500）
- `POST /v2/chat/completions` → OpenAI 兼容 SSE 对话
  - 海外版：`https://www.workbuddy.ai`
  - 大陆版：`https://copilot.tencent.com`（CodeBuddy 中国网关；`www.workbuddy.cn` 会对 harness 流量回 `Illegal API invocation from an unapproved channel`，所以聊天走这条，`X-Product-Code` 仍为 `workbuddy`；主通道异常时自动回退 `www.workbuddy.cn`）
- `POST /v2/billing/meter/get-user-resource` → 积分包（签到发的包带 `grantSource: daily_checkin`）
- `POST /v2/billing/meter/checkin-status` → 签到活动状态（`active` / `today_checked_in` / `streak_days` / `week_progress`）
- `POST /v2/billing/meter/daily-checkin` → 领取当日积分（今天已领 → `code 10001`）

### 系统提示词改写（两个部署统一）

国内网关会把**以这句开头**的 system 消息判成"未获批渠道"（`code 11128`）：

```
You are an AI agent powered by DeepSeek Harness.
```

规则是**行首锚定、大小写不敏感、句末句点可选**的品牌指纹：单独出现 `DeepSeek Harness`、前面加一个词、或换成 `You are a coding agent powered by …` 都不拦。适配器把这一句改成 `You are an AI agent.`，其余内容原样保留；海外版网关本来不拦，但也走同一条改写路径，避免两套提示词形态。

凭据以普通 credential reference 存储：

| Reference                | 内容                                    |
| ------------------------ | --------------------------------------- |
| `WORKBUDDY_INTL_TOKEN`   | 裸 access token（直接作为 Bearer 发出） |
| `WORKBUDDY_INTL_ACCOUNT` | JSON：refresh token、到期时间、账号信息 |
| `WORKBUDDY_CN_TOKEN`     | 同上（大陆版）                          |
| `WORKBUDDY_CN_ACCOUNT`   | 同上（大陆版）                          |

## 目录结构

```
dsh-workbuddy/
├── package.json            # bundle 声明（dsh.bundle.patch / dsh.client）
├── cordis.patch.yml        # 只插入一行 Host 插件
├── icon.webp               # 插件图标（不透明标记，走 /workbuddy/icon）
├── icon-mask.png           # 同一形状的 alpha 剪影，面板用 CSS mask 上色（跟随主题）
├── locale/{en,zh}.json     # 插件清单标题与描述
├── AGENTS.md               # 贡献/二次开发须知（不变量、流程、坑）
├── LICENSE                 # MIT
├── src/                    # Host 半边
│   ├── index.js            # apply()：provider 路由、/workbuddy 命令、定时器
│   ├── regions.js          # 部署定义、聊天路由顺序、区域选择、打开浏览器
│   ├── http.js             # 传输与信封工具、JWT/日期工具
│   ├── auth.js             # 登录/续期协议、凭据读写、账号状态
│   ├── catalog.js          # 实时目录（scoped + /v3/config 并行合并）+ 准入策略
│   ├── catalog-cache.js    # 目录落盘缓存（追加、缺字段不覆盖、倍率不缓存）
│   ├── availability.js     # 可用性台账（最小请求探测、11102 判死、12 小时有效期）
│   ├── credits.js          # 积分、签到、启动/午夜自动领取
│   ├── adapter.js          # llm 适配器（序列化、SSE、路由回退、提示词改写）
│   └── api.js              # 设置页用的宿主 HTTP 路由 /workbuddy/*
├── client/
│   └── index.js            # 设置页 UI（settings.section 槽位）
├── docs/
│   ├── workbuddy-protocol.md   # 上游接口/字段/错误码/指纹与实测记录（排查前先看）
│   └── ui-preview.png          # 设置面板外观预览（由 test/live/ui-preview.mjs 生成）
└── test/
    ├── unit/               # 离线单测（npm test）
    └── live/               # 需要真实账号的在线探针
```

## 设置面板

![设置面板](docs/ui-preview.png)

两张卡片，各管一件事：

**账户卡片** —— 表格是**转置**的：部署是列、字段是行，两个账号并排对比。

| | ● 大陆版  `[今日已签到]` | ● 海外版 |
| --- | --- | --- |
| 账号 | 示例账号 | 900000001 |
| 到期 | 2027/01/16 09:00:00 | 2027/04/21 12:00:00 |
| 积分 | **1280.00** ⟳ | **360.00** ⟳ |
| 操作 | `[更换账号] [退出登录]` | `[更换账号] [退出登录]` |

（列顺序就是宿主的显示顺序：大陆版在前，默认打开也是它。整张卡片右上角有**一个**「续期」，两个部署一起续，未登录的跳过。）

- 部署名旁的圆点是登录状态（绿=已登录 / 黄=等待授权 / 红=已过期 / 灰=未登录），悬停显示 `provider · endpoint`。
- 积分右侧的 **⟳** 只刷新这一行（走 `GET /workbuddy/credits?region=…`），不动其它数据。
- 同一行最右边还有 **「套餐」**：在浏览器打开该部署的官方套餐/用量页（大陆版 → `workbuddy.cn/profile/plans-usage`，海外版 → `workbuddy.ai/profile/plans-usage`）。地址由宿主从**页面白名单**解析，面板只传一个页面名，所以这个入口无法被用来打开任意网址。
- 每列的**值贴左边缘**（与账号、到期对齐），**⟳ 与「套餐」贴右边缘**，中间留白，窄面板下也不会挤出横向滚动条。
- **未登录的部署整列只显示一个居中的「登录」按钮**，不再是四行「未知」加一堆禁用按钮。
- 签到按钮（只有大陆版有）跟在部署名右边，悬停显示上次自动领取的结果。

**模型卡片** —— 顶部标签切换要查看哪个部署（只切换查看，不影响登录状态）：

- 按**能不能用**分两组：`可用模型` / `不可用模型`（探测判定 + 真实调用的自学习）。不可用分组默认折叠。
- 每行：左侧圆点是台账颜色（绿=可用、黄=排队、红=不可用/无权限、灰=未检测），中间是模型名，右侧依次是**可用性标签 · 促销标签 · 繁忙程度 · 实时倍率**，最后是该模型的**启停开关**（停用的行会变淡）。
- 点任意一行展开详情：描述、标识、上下文、最大输出、模态、思考档位、可关闭思考、倍率、繁忙程度、促销类型/时限/详情。所有标签共用一种样式，颜色只表示语义。
- 倍率取不到就显示「未知」（**不猜、不用旧值兜底**），`0` 显示「免费」标签。
- 繁忙程度**只有大陆版有**（`POST /v2/chat/busy`；海外版 404，那一列整个不显示）：空闲 / 繁忙 / 拥堵 / 未知四档，用词与官方前端一致（官方把 `normal` 与 `idle` 并成「空闲」），悬停给出官方的完整说法（轻微拥堵 / 极度拥堵）。
- 工具栏：搜索框、「全部启用 / 全部停用」（**只作用于可用分组**，不可用分组自己手动调）、「⟳ 刷新列表」、「检测可用性」（手动，立即执行）。这两个按钮宽度固定，「检测中…」不会把 ⟳ 挤走。
- 打开面板时会自动检测一次（国内零消耗、可频繁；海外版每次探测一 token，每天最多一次）。
- 开关**立即生效**：翻转后插件会通知 harness「模型集变了」，模型选择器随即重读目录（它的目录是缓存的，不通知就会一直显示已关掉的模型）。可用性探测结果与真实调用中学到的判定也会即时反映到默认开关上。

> 该预览由 `node test/live/ui-preview.mjs` 用真实样式表生成到 `%TEMP%/wb-ui-preview.html`，改版后可以直接截图对比。

分层方向单向：`regions/http` ← `auth/catalog` ← `credits/adapter` ← `api/index`；`client/index.js` 只通过宿主路由与后端通信，不 import 任何宿主模块。

适配器刻意不 import `@deepseek-ai/dsh-llm`，而是按契约鸭子类型实现（`providerInfo` / `listModels` / `resolveModel` / `prepareCall → { model, stream }` / `imageRequestTarget` / `imageRequestPricing`），因此这个包可以独立用 npm 安装，也不会因为仓库里存在两份 dsh-llm 而出现 `instanceof` 失效。

## 测试

> **改了 `src/**` 之后请退出并重启 DSH Desktop。** 插件重新启用只会在缓存住的模块上重跑
> `apply()`，改动不一定生效——面板整体报 `HTTP 404` 往往就是这一条（细节见
> [`docs/workbuddy-protocol.md`](docs/workbuddy-protocol.md) §11.3）。`client/**` 的改动会热重载。

```sh
npm test                          # 下面 10 个离线单测
node test/unit/plugin.mjs         # provider 注册、目录、/workbuddy 命令、HTTP 路由
node test/unit/api.mjs            # 面板接口：状态载荷、积分/签到、参数校验、信任栅栏
node test/unit/client.mjs         # 客户端：注册、词典回退，以及三种状态下的完整面板渲染
node test/unit/region-order.mjs   # 显示顺序 ↔ 客户端占位顺序 ↔ 默认标签三者一致
node test/unit/catalog.mjs        # 双数据源并发抓取、合并、回退
node test/unit/catalog-cache.mjs  # 追加语义、缺字段不覆盖、倍率不落盘、读取时重放准入
node test/unit/official-list.mjs  # 名单导入（id 或记录）、字段级富化（不含倍率）、清理
node test/unit/model-prefs.mjs    # 判定默认值、手工覆盖、批量开关、分部署探测形态
node test/unit/availability.mjs   # 探测分类、dead 有效期、按 id 合并、分部署台账
node test/unit/adapter.mjs        # 提示词改写、请求体组装、聊天路由顺序、排队错误映射
```

`client.mjs` 那一层值得单独说：它用一个小号 React（状态更新会重渲染、effect 在函数体之后执行）
把面板**真的渲染出来**，断言输出里有账号、分组、模型名、促销与繁忙标签、倍率与「未知」。
面板是一个大函数，少了某个 helper 或词典键在应用里就是一片空白，只有这一层能拦住。

需要真实账号的在线探针（读取 `$DSH_HOME/.credentials.yaml`，需要先登录过）：

```sh
node test/live/smoke.mjs              # 端到端：目录 → 对话 → 工具调用
node test/live/availability-sweep.mjs [cn|intl]   # 可用性全量探测并写台账
node test/live/credits-check.mjs      # 积分包与签到状态
node test/live/intl-probe.mjs         # 海外版目录端点与回退
node test/live/models-chat-probe.mjs  # 逐模型最小请求，区分排队/不可用/正常
node test/live/promotion-shape-probe.mjs  # modelPromotions 的字段形状
node test/live/busy-probe.mjs         # /v2/chat/busy 的两部署可用性
node test/live/ui-preview.mjs         # 用真实样式表生成面板预览页（截图对比用）
node test/live/harness-contract-replay.mjs  # 复刻 harness 校验，排查「选择器整组消失」
node test/live/host-log-tail.mjs 关键字     # 按 UTF-8 读宿主日志
node test/live/policy-probe.mjs       # 两版白名单与准入结果对照
```

完整的探针清单（含每个脚本的用途）在 [`docs/workbuddy-protocol.md`](docs/workbuddy-protocol.md) 的附录。

> Windows 上打开授权页必须走 `cmd /c start "" "<url>"` + `windowsVerbatimArguments`：
> 登录 URL 带 `&`，不加引号会被 cmd.exe 当成命令分隔符截断，浏览器只拿到
> `.../login?platform=…`，WorkBuddy 会回「登录链接不完整」。这条约束实现在
> `src/auth.js` 的 `openLoginUrl()` 里。

## 模型目录的数据源

两个端点**并行**取，只用实时数据，没有本地模型表：

| 来源 | 角色 | 说明 |
| --- | --- | --- |
| `GET /console/enterprises/personal/models` | 定列表 | 账号维度，决定"这台账号有哪些模型" |
| `GET /v3/config` | 补字段 | 部署维度，补上 scoped 没写的等级集合、描述、倍率等 |

- scoped 成功 → 用它定列表，用 config 逐字段补空（同 id）；config 独有、scoped 没有的 id **不并入列表**（那些多是已下线条目）。
- scoped 失败 → 直接用 config（海外版当前的常态）。
- 两个都失败 → 用下面的**本地缓存**；连缓存都没有才是空列表（面板标「取不到模型列表，点刷新列表重试」）。
- 内存缓存 10 分钟；登录、退出、点「刷新列表」(`/workbuddy/models?refresh=1`) 会立即重取。

### 准入策略（哪些模型进列表）

按顺序判定，一条不满足即剔除：

1. **裸路由别名不进列表**：`auto`、`default`。它们其实能调通（实测国内 `auto` 会路由到 `hy4-preview`），但官方选择器不展示，所以不广告；已被钉住的长会话仍可调用。
2. **路由预设两版都剔除**：`default-model`（显示为 Auto）、`fast-model`、`balanced-model`、`primary-model`、`deep-model` —— 它们按请求临时挑后端、倍率浮动，不是具体模型。海外版因此从 28 条减到 24 条。同样仍可被已钉住的会话调用。
3. **白名单优先**：`agents[cli].models`（官方 CLI 可用的 id）无条件保留 —— 两个网页端的选择器就是按这份名单渲染的。**注意两版白名单不同**，各读各自 payload 里的那份：国内 scoped 19 条 / config 20 条（差 `hy3-x`），国际 28 条。
4. **白名单外必须有实时倍率**：`credits` 有值才留。倍率是"这个模型确实在售"的唯一凭据；网页端不展示、又不标价的模型不提供（国内因此挡掉 `hunyuan-chat` 等）。
5. 非对话后端（`completion-*` / `codewise-*` / `nes-*` / `hunyuan-image*` / `kling-video*` / `minimax-video*`、`maxOutputTokens ≤ 256`、`tags` 含 `text-to-image`）一律不进列表 —— 实测 `hunyuan-image-alpha` 会回 `400 模型配置异常… Backend [hunyuan-stream] is not supported`。

实测结果（2026-10-21 18:2x）：国内 34 → **30**（官方 19 + 有倍率的非官方 11），国际 28 → **24**（全为官方名单成员）。

### 可用性台账（目录说是，网关不一定给）

有倍率 ≠ 能调用：国内那 11 个"有倍率的非官方"里，**8 个一调就 `11102 model [...] service info not found`**（目录里的僵尸条目）。`POST /v2/chat/busy` 也救不了——它对活跃集合之外的模型一律回 `unknown`，能用不能用都是 `unknown`。唯一的判据是**发一个请求**，而两个部署的可选写法并不相同（都是实测）：

| | 大陆版 | 海外版 |
| --- | --- | --- |
| 网关校验顺序 | **先解析模型，后校验参数** | **先校验请求形状**（空/首条非 system → `11128 first message is not system`） |
| 探测请求体 | `{"model":M,"messages":[],"stream":true}` | `{"model":M,"messages":[{system:""}],"stream":true,"max_tokens":1}` |
| 判定 | 活 → `11133`/`11151`；已下架 → `11102` | 可用 → `11151`/`11133`/`200`；**账号无权限 → `11158`**；已下架 → `11102` |
| 代价（各 8 次实测） | `glm-5.3`(0.69x) → **积分 0 变化** | `kimi-k3`(1.62x) → **积分 0 变化**；`hy3` → 200 但 6 秒内零内容，同样 0 变化 |

海外版那一格的关键是**空的 system 内容**：它满足了"首条必须是 system"的形状要求，又让大多数模型在生成前就回 `11151 a message has empty content`（校验层错误，不派发给模型）。带内容的写法（`system "."`）才会真的走到 `200`。

- 回答"空 system 算不算 token"：**若请求真的发给模型，角色本身要算**——聊天模板会加 `<|im_start|>system\n…<|im_end|>\n` 这种固定开销（约 3–6 token），空内容只是不加正文 token。但探测请求到不了那一步：`11151`/`11133` 都是校验层拒绝，**没有 token 被计费**（计费接口最小刻度是 1 积分，实测整数余额不动）。
- 试探过但**无效**的写法（都实测过）：`reasoning_effort:"测试"`、`thinking:{type:"测试"}`、孤儿 `tool_calls`、`messages:[]`（海外版）、`max_tokens:0/-1`、`stop` 类型错误 —— 要么被两个网关直接忽略（照样生成），要么在模型校验之前就被拒（`11101 Unmarshal chat params failed`），拿不到任何模型信息。
- **`11158`（无权限）**：`model [x] is not allowed for user type [personal_free_user]`。海外版免费账号调 GPT 系列就是它；`/v3/config` 的 `modelTiers[].modelIds` 列出的正是这批（12 个，实测与 `11158` 集合完全一致，文案「模型仅面向 Pro 用户开放」），可以用来提前解释，但真正的判定仍以探测/真实调用为准。
- 判定表（`classifyProbe`）：`ok`(200·11133·11151·其它 4xx) / `dead`(11102) / **`denied`(11158)** / `busy`(429·6020) / `blocked`(11128) / `auth`(401·403) / `down`(5xx) / `error`。面板上只呈现三种结论：
  - **`不可用`（红）**：仅 `11102`，即模型 id 在网关注册表里不存在；
  - **`无权限`（橙）**：`11158`（账号档位不够）+ `11128`（被判定为未获批渠道，即"被拦截"）；
  - **`未知`（灰）**：其余无法下结论的报错（5xx、凭据、请求形状被拒），原始报文留在悬停提示里。
  `ok` 与未检测都不显示标签。**分组只看结论**：`不可用模型` = 前两种，其余（含未知、排队中）留在 `可用模型` 组——没被证伪的就不当成不能用。
- 台账落盘：`$DSH_HOME/cache/dsh-workbuddy/availability-<region>.json`，按 id 记 `{state, detail, at}`，新结果覆盖旧结果、其它条目保留；不可用判定的**有效期 12 小时**，过期后该模型按可用对待（并在下次检测时复验）。同一文件还记 `lastSweepAt`，用于"多久才能自动再扫一次"。
- **自学习**：真实对话里若某个模型回 `11102` 或 `11158`，适配器直接把这条写进台账并失效目录缓存——不需要等下一次检测，也不额外花任何请求。
- **触发方式**：
  - 打开设置面板即触发一次**自动**检测（按部署节流：国内 10 分钟、国际 24 小时）；
  - 「检测可用性」按钮 = **手动**，立即执行、不看节流；
  - `/workbuddy check [intl|cn|all]` = 手动，全量；
  - `GET /workbuddy/availability?region=cn&refresh=1[&manual=1]`。
- 结果（2026-10-21 21:2x，国内全量 30 个，零消耗）：`ok` 22 / `dead` 8（`glm-5.0`、`hy4-preview-x`、`glm-4.7`、`glm-4.6`、`glm-4.6v`、`minimax-m2.5`、`kimi-k2-thinking`、`hunyuan-2.0-thinking`）。海外版全量 24 个：`ok` 12 / `denied` 12（GPT 系列 + `grok-4.7` + `gemini-3.x-flash`）。

### 每个模型的开关（`$DSH_HOME/cache/dsh-workbuddy/enabled-<region>.json`）
面板里每行右侧有一个开关，决定该模型**是否出现在模型选择器里**（面板本身始终保留它，随时可以开回来）：

- **默认跟随检测结果**：`dead` / `denied` 默认**关**，其余默认**开**——不用手工维护就能得到一份合理的列表。
- **手动作业永远优先**：把不可用的模型打开正是"不信邪想试试"的路径；把能用的关掉可以让选择器短一些。
- 只落盘**手工决定**（`on`/`off` 两个 id 集合），所以明天上游新增的模型会按自己的检测结果决定默认值，不会莫名其妙消失或出现。
- 一键操作：工具栏「一键启停」（整个列表翻转）、分组标题旁的「全部启用 / 全部停用」（就那一组）。
- 接口：`POST /workbuddy/enabled {region, id|ids, enabled}`，`reset:true` 表示"忘掉手工决定、回到检测默认"。

### 本地缓存（`$DSH_HOME/cache/dsh-workbuddy/catalog-<region>.json`）

上游偶尔取不到时不再"忽有忽无"：最后一次成功读取会落盘，两个实时源都失败时启用，面板标「本地缓存 (时间)」。

- **追加**语义：每次实时读取按模型 id 并入缓存，新 id 加入、老 id 刷新字段，**这次没提到的模型保留**（上游某次答得少不会把列表缩短）。
- **缺字段不覆盖**：新数据没带的字段（描述、上下文窗口、档位、能力位等）保留旧值；`efforts` 与 `input` 取并集。
- **倍率不进缓存**：`credits` 是实时值（还有促销浮动），缓存里不存、读的时候也丢弃；取不到时面板显示「未知」。
- **准入策略在读取时同样生效**：缓存是追加的，后改的规则必须能作用于旧快照。因为倍率不落盘，缓存命中的列表实际收敛为"白名单那部分"（官方名单不依赖实时倍率）。
- 写入是原子的（临时文件 + rename），旧快照留一份 `catalog-<region>.prev.json` 供排查/回滚。

> 海外版**没有第三条可用源**：它的 Web 应用同样调上面两个端点；控制台侧的 `…/personal/config`、`…/personal/models/list`、`/console/as/users/private-configs/query` 都需要 Web cookie，插件令牌访问一律 403。

## 已知差异

- 大陆版 `/v3/config` 对插件令牌曾返回 `code 12403`（"check ua, get coding copilot version error"），2026-10-21 傍晚起已可正常访问（62 条模型，含已下线条目）。
- 海外版 `/console/enterprises/personal/models` 自 2026-10-21 起返回 500（APISIX，无令牌时报 400 `Client not found.`、假令牌也 500），目录自动走 `/v3/config`。
- 目录里的部分 id 并非具体模型而是路由预设（`auto` / `default` / `default-model` / `fast-model` / `balanced-model` / `primary-model` / `deep-model`），面板把它们单独列为"预设"。
- **思考档位只认服务端声明的 `reasoning.supportedEfforts`**（两个源合并后国内 15/34、国际 21/28）；只声明了默认档的模型不给档位列表 —— 与网页端行为一致。合并后仍无档位的，请求里不带 `reasoning_effort`，由服务端取默认。
- 实时**繁忙程度**只有大陆版有（`POST /v2/chat/busy`，海外版 404，`regions.js` 的 `hasBusy` 决定那一列是否显示）。它**不是可用性信号**：只对白名单内的活跃模型返回 `idle/normal/busy/congested`，其余一律 `unknown`（面板显示「未知」，不当成故障）。插件侧 50 秒缓存，与官方前端一致。
- 两版**条目数会变**：2026-10-22 实测大陆版 30 个（`ok` 22 / `dead` 8）、海外版 25 个（`ok` 13 / `denied` 12）。`gpt-5.3-codex` 只在账号名单里，两个 `/v3/config` 都没有它，倍率因此是「未知」。

## 上游行为与错误映射

### 重试归属

退避重试**全部由 harness 负责**（`@deepseek-ai/dsh-llm-retry`，`agent/request-error` 瀑布，默认 5 次、500ms 起指数退避 + 抖动、上限 10s）。适配器只做两件**即时**补救，都不是退避重试：

1. `Illegal API invocation from an unapproved channel` → 换会话标识重发一次，仍失败则切备用聊天路由；
2. `401/403` → 先续期令牌再发一次。

因此适配器**不转发上游的 `retry_after`**：节拍只由一套策略掌握，避免两套退避互相干扰。

- **模型排队**：繁忙时腾讯网关回 `HTTP 429` + 业务码 `6020` + 未翻译的 i18n key `queue.waiting.title`，并带 `data.queue_position`。适配器把它转成可读的「模型排队中（队列第 N 位），将自动重试」，错误码 `RATE_LIMIT`，交给 harness 退避重试。
- **未获批渠道**：见上文「系统提示词改写」。
- **模型不可用**：`code 11102 model [...] service info not found`（例如目录里列了但 CLI 渠道不服务的 `glm-4.6` 等）→ `INVALID_REQUEST`，不重试。
- **额度/限流**：其他 429 → `RATE_LIMIT`；401/403 → 先续期再重试一次；5xx → `SERVER`。

## 许可

MIT，见 [`LICENSE`](LICENSE)。再次说明：本项目为第三方非官方插件，与腾讯 / WorkBuddy 无关联。
