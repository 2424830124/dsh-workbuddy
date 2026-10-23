# AGENTS.md

给 AI agent 和人类贡献者的仓库说明。**动手前先读这一页**，里面的坑都是踩过的。

## 这是什么

`@huai_xin/dsh-workbuddy` 是 DeepSeek Harness（DSH）的一个插件：把 **WorkBuddy** 的两个部署
（`workbuddy-intl` 海外版 / `workbuddy-cn` 大陆版）注册成 llm provider 路由，并提供一个
设置面板管理账号、模型开关与可用性。

- 上游接口、字段、错误码、实测记录：[`docs/workbuddy-protocol.md`](docs/workbuddy-protocol.md)（排查问题先看它）
- 使用者视角的说明：[`README.md`](README.md)

## 目录与分层

```
src/
  index.js          apply()：provider 路由、命令、定时器（包入口，main 指向它）
  core/
    paths.js        插件自己的目录与凭据文档（$DSH_HOME/dsh-workbuddy/）
    http.js         传输与信封工具、JWT/日期工具
    regions.js      部署定义（端点、探测形态、聊天路由、是否支持繁忙度）
    topology.js     通知 harness「可选模型变了」
  account/
    auth.js         登录/续期协议、凭据读写、账号状态
    credits.js      积分、签到、启动/午夜自动领取
  catalog/
    catalog.js      实时目录（scoped + /v3/config 并行合并）+ 准入策略
    catalog-cache.js 目录落盘缓存（追加、缺字段不覆盖、倍率不落盘）
    availability.js 可用性台账（最小请求探测、分类、12 小时有效期）
    model-prefs.js  每个模型的启停（只落盘"手工决定"；退出时整区隐藏）
    official-list.js 账号名单导入（id 或记录，字段级富化，不含倍率）
    busy.js         /v2/chat/busy 的繁忙程度（仅大陆版）
  llm/
    adapter.js      llm 适配器（请求组装、分片组装、路由回退、提示词改写）
    wire.js         Harness 消息 → OpenAI wire 消息（工具结果角色、配对、图片）
    sse.js          SSE 分帧（bytes → data payload、[DONE]、取消响应体）
    endings.js      结束分类表（finish_reason × 正文 × 工具 × 断流）
    recovery.js     自动续写的决策与载荷
  panel/
    api.js          面板用的宿主路由 /workbuddy/*
client/index.js     设置面板（`settings.section` 槽位的客户端半边）
test/unit/          离线单测（`npm test`，15 个）
test/live/          需要真实账号的在线探针与诊断脚本
```

依赖方向单向：`core` ← `account`/`catalog` ← `llm`/`panel` ← `index`。
`client/index.js` **不 import 任何宿主模块**，只通过 `/workbuddy/*` 路由通信。
它是**单文件 bundle**（`dsh.client` 只支持一个 `client.js`，`factory(require)` 只能解析已注册的
模块），所以**不要**尝试把面板拆成多个文件 —— 拆了就得引入打包器，而本项目不引依赖。

## 不能违反的不变量

1. **`defaultEffort` 必须在 `efforts` 里**。harness 校验 `resolveModel` 的结果，违反会让
   **整个 provider 的模型在选择器里消失**。三处统一由 `withConsistentEfforts()` 保证
   （新条目、合并、缓存读回）。
2. **适配器是鸭子类型，7 个方法一个都不能少**：`providerInfo`、`providerRetryPolicy`、
   `listModels`、`resolveModel`、`prepareCall`、`imageRequestPricing`、`imageRequestTarget`。
   harness 在**注册时**就会调用前两个，缺一个直接 `TypeError` → `apply()` 失败 →
   provider 与全部 HTTP 路由都不注册，面板只剩 `HTTP 404`。
   `test/unit/plugin.mjs` 的假注册表会调用同样的表面，删方法离线就会红。
3. **倍率与促销不进缓存**。`VOLATILE_FIELDS` 里现在是 `credits`（实时倍率）与
   `promotion`（随活动变化的促销）；集合里还留着 `canDisableThinking`，那只是为了让
   老快照读出来时把已废弃字段丢掉。取不到就显示「未知」，**不要用旧值兜底、不要猜**。
   加新字段前先问一句：它会随时间变吗？上游会哪天不发了（缓存又不会清）吗？会，就加进来。
4. **准入策略在读取缓存时也要生效**（缓存是追加的，规则会变）。
5. **显示顺序三处一致**：宿主 `REGION_IDS` ↔ 客户端 `PLACEHOLDER_REGIONS` ↔ 初始标签，
   由 `test/unit/region-order.mjs` 钉住。顺序不一致会让标签在加载完成的瞬间翻转。
6. **只有唯一判据能判定"不可用"**：发一个探测请求。目录字段、`/v2/chat/busy` 都不可靠
   （详见协议文档 §4.9）。探测形态两个部署不同，不要互相套用。
7. **改了"选择器能选哪些模型"，必须调 `notifyModelTopology(ctx)`**（`src/topology.js`）。
   客户端的模型目录是**缓存**的，只在收到转发事件（`llm/adapters-updated` 等）时才重读；
   少了这一步，面板里刚关掉的模型仍会留在模型选择器里，直到用户刷新 GUI。已有的触发点：
   `/enabled` 开关、`/import` 名单、`/models?refresh=1`、可用性探测完成、真实调用中的自学习
   （`rememberUnusable`）。新增类似的写入路径时照做。
8. **思考恒为开启，没有"关闭思考"开关。** 上游只发 `reasoning.canDisableThinking` 这个
   布尔位，却从没给出能兑现它的请求参数（实测见协议文档 §4.3.1），所以目录解析直接忽略
   该字段、面板也不摆开关 —— **能调的只有档位**。
   档位规则**对所有模型一致**，不看模型名：调用方选的档位（且该模型声明了它）→ 目录里的
   `defaultEffort` → `high` → 首档；一个档位都没声明就不发 `reasoning_effort`。
   请求里**不发 `thinking` 字段**（2026-10-23 实测：带不带它对是否思考没有影响，`max` 档下
   不带反而思考更多；官方客户端只在关闭思考时才发 `{type:'disabled'}`）。
   不要重新引入 `canDisableThinking`，也不要凭空发明关闭参数或按模型名分支。
9. **流必须以 `data: [DONE]` 收尾。** 没有 `[DONE]`、也没有 `finish_reason` 就断流，是连接被
   掐断，必须上报 `TRANSPORT` 错误（让重试策略接管），**绝不能映射成 `stop`** —— 否则用户看到
   的是"话说一半就停了，还不重试"，而且日志里什么都没有。同理，**参数被截断的工具调用不要
   交付**（它是坏 JSON，交出去只会变成工具解析错误）：丢掉它并报 `max-tokens`，让 harness
   自己续跑该步骤（协议文档 §4.5）。
   **`finish_reason` 要按整张表映射**（对齐官方 CLI 的 `mapFinishReasonToStopReason`）：
   `stop`/`end_turn`/`stop_sequence` → `stop`；`tool_calls`/`tool_use`/`function_call` → `tool-calls`；
   `length`/`max_tokens` → `max-tokens`；`refusal`/`content_filter` → **不可重试的
   `INVALID_REQUEST` 错误**（不是 stop）；`error` → `TRANSPORT`（可重试）；未知值记日志后按 `stop`。
   **有工具调用分片但始终没有工具名**时同样必须是 `TRANSPORT` 错误 —— 那个调用无法交付，
   静默丢弃会让整步看起来像模型自己收尾（协议文档 §12.2）。
10. **finish 帧必须带 `response` 诊断块**（`kind`/`version`/`api`/`provider`/`model`/`responseId`/
    `stopReason`/`outputTokens`/`blocks`），由 `finishChunk()` 统一生成 —— **所有** finish 出口都走它。
   它不是 harness 的契约字段（`dsh-llm` 类型里没有 `response`/`stopReason`），纯属遥测：会话数据
   诊断会原样显示，用来回答"这一步是谁答的、上游 id 是什么"。不要绕过 `finishChunk()` 手写
   `{type:'finish'}`，那样诊断里就只剩一个 `reason`，排查时又得从 `request/header` 反推。
11. **聊天请求必须带齐语义头**，否则网关直接 `400 code 11128 request illegal`（2026-10-23 实测：
    少了 `X-Agent-Purpose` / `X-Conversation-*` / `X-IDE-*` 就是这个结果）。取值来自官方 CLI 的
    常量：`X-Agent-Intent: craft`（"动手干活"模式，此前漏发）、`X-Agent-Runtime: local-agent`、
    `X-Session-ID` / `X-Model-ID`，以及 `X-Conversation-Message-ID` / `X-Request-ID` ——
    后两个标识**被回答的那条消息**，必须由消息内容导出（同一重试保持不变），
    不要每条请求都随机 UUID。
12. **请求体与官方的唯一实质差异是采样参数**：官方总带 `temperature`/`top_p`/两个 penalty，
    我们只在调用方显式传 `temperature` 时才发。实测（默认/0.2/0.5/0.7/0.3+top_p0.9 各 8 次）
    对"提前收尾"没有影响，所以不跟随；真要改，先拿数据说话（协议文档 §12.1）。
13. **工具结果必须保持 `tool` 角色**。Harness 把一次工具结果作为**独立消息**送来：
    `{ role: 'tool', source: { kind: 'tool', callId }, content: [...] }`（老的 transcript 还有
    嵌在 content 里的 `tool-result` 块，两种都要认）。把它降级成 `user` 消息，模型就不知道
    结果回答的是哪个 `tool_call`，配对判定还会顺手丢掉那些调用 —— 症状是模型在长任务里
    写一句"我需要先读取…"就收尾，而 `finish_reason` 是合法的 `stop`
    （2026-10-23 的 [issue #1](https://github.com/2424830124/dsh-workbuddy/issues/1) 就是它，
    修复见 `0.1.16`）。`developer` 消息按 `system` 发送。
    排查时先核对我们**发出去**的 transcript，再怀疑上游。
14. **一轮里最多自动续写一次**（`stream()` 包着 `streamRound()`，参考客户端的
    `streamRecovery`）。只有两种结束值得续写：**在 `[DONE]`/`finish_reason` 之前断流**，
    以及 **`stop` 但只有思考、没有正文**（用户那边等于空回复）。`max-tokens` **不在这里续**——
    harness 自己会续跑该步骤（不变量 9）。续写是一轮新的请求：把已产出的正文/思考当作
    "incomplete draft" 附上，要求它给最终答案、**不许调工具**；块索引按 `maxIndex + 1` 偏移，
    否则会和前一轮的块撞号。`usage` 要累加后只发一次，`finish` 只发最后一次。

## 开发流程

- **改了 `src/**` 必须重启 DSH Desktop。** 重新启用插件只会在缓存住的模块上重跑 `apply()`，
  改动不一定生效——曾经因此让插件注册失败、面板全面 404，而重载也"修不回来"。
  `client/**` 的改动会热重载。判断办法：日志里有没有**新的** `已注册 provider …（实例 xxxx）`。
- 不重启也能确认文件本身没问题：`node test/live/boot-path-check.mjs`（独立进程里真实跑 `apply()`）。
- 提交前跑 `npm test`。新增行为请补单测；面板相关的改动至少让 `test/unit/client.mjs` 的
  渲染断言覆盖到（它用一个小号 React **真的渲染**面板，缺 helper / 缺词典键会当场报错）。
- 面板外观改动后跑 `node test/live/ui-preview.mjs` 并用截图对比（输出在 `%TEMP%`）。

### 15 个离线单测各管什么

```sh
npm test                          # 全部
node test/unit/plugin.mjs         # provider 注册、目录、/workbuddy 命令、HTTP 路由
node test/unit/api.mjs            # 面板接口：状态载荷、积分/签到、参数校验、信任栅栏、图标
node test/unit/client.mjs         # 客户端：注册、词典回退、三种状态的完整渲染、同名排序
node test/unit/region-order.mjs   # 显示顺序 ↔ 客户端占位顺序 ↔ 默认标签三者一致
node test/unit/wire.mjs           # 工具结果保持 tool 角色、配对、旧格式、角色映射、reasoning 回放
node test/unit/endings.mjs        # 结束分类整张表 + 优先级
node test/unit/recovery.mjs       # 一轮上限、usage 累加、索引偏移、续写载荷、清空 tools
node test/unit/catalog.mjs        # 双数据源并发抓取、合并、回退
node test/unit/catalog-cache.mjs  # 追加语义、缺字段不覆盖、倍率不落盘、读取时重放准入
node test/unit/official-list.mjs  # 名单导入、字段级富化（不含倍率）、清理
node test/unit/model-prefs.mjs    # 判定默认值、手工覆盖、批量开关、分部署探测形态
node test/unit/availability.mjs   # 探测分类、dead 有效期、按 id 合并、分部署台账
node test/unit/auth.mjs           # 退出删凭据、陈旧续期/登录结果不写回
node test/unit/logout.mjs         # 退出隐藏全部模型、登录恢复判定默认
node test/unit/adapter.mjs        # 提示词改写、请求体组装、聊天路由顺序、排队错误映射
```

`client.mjs` 那一层值得单独说：它用一个小号 React（状态更新会重渲染、effect 在函数体之后执行）
把面板**真的渲染出来**，断言输出里有账号、分组、模型名、促销与繁忙标签、倍率与「未知」。
面板是一个大函数，少了某个 helper 或词典键在应用里就是一片空白，只有这一层能拦住。

### 排查用的三行日志

- 排查面板/选择器问题时先看这三行（都在宿主日志里）：
  - `已注册 provider …（实例 xxxx）` —— 这次加载到底是不是新代码；
  - `已通知模型拓扑变化（ctx.emit）` —— 开关等写入是否通知了 harness；
  - `<region>: 选择器读取目录 → N/M 个可选` —— 选择器**每次**读目录都会打，
    它出现在开关之后就说明客户端确实重读了（没有它 = 客户端还在用缓存）。
- 排查"回答到一半停了"时看这两行（前者是原因，后者是补救）：
  - `<model> 的响应在 finish_reason/[DONE] 之前中断（收到 … kB，用时 …s，…）`；
  - `第 N/M 次重试（TRANSPORT）… 后重试` —— 重试本身由 `dsh-llm-retry` 执行，
    我们只是把它的决定打进日志（订阅 `session/event` 的 `llm/retry`），否则重试成功时
    外人看不出发生过什么。
  - 想量一下上游断流频率：`node test/live/stream-cut-probe.mjs [cn|intl] [次数] [模型] [--long] [--selftest]`
    （`--selftest` 离线自检分类；大陆版零消耗，先跑它）。

## 在线探针

需要真实账号（`$DSH_HOME/dsh-workbuddy/credentials.json` 里的 `WORKBUDDY_INTL_TOKEN` / `WORKBUDDY_CN_TOKEN`，
由面板登录写入；不再使用宿主的 `.credentials.yaml`），
所以**不会**在 CI 里跑。常用：

```sh
node test/live/host-log-tail.mjs 关键字      # 按 UTF-8 读宿主日志（PowerShell 会乱码）
node test/live/picker-contract-check.mjs     # 适配器实际给模型选择器什么
node test/live/harness-contract-replay.mjs   # 复刻 harness 校验，定位"选择器整组消失"
node test/live/availability-sweep.mjs cn     # 可用性全量探测
node test/live/leak-scan.mjs                 # 发布前必跑：账户信息/凭据泄露扫描
```

**"回答为什么停在这里"** 用会话取证探针（会话日志是多帧 zstd，最新帧常是残帧，这两个脚本
用 `ZSTD_e_flush` 容错）：

```sh
node test/live/session-tail-live.mjs [会话前缀] [步数] [项目过滤]   # 末尾几步 + stopReason + 正文
node test/live/last-finishes.mjs "" [步数] dsh-model-picker          # 每步 stopReason 与分布统计
```

`finish` 帧的 `response.stopReason` 是上游原话：`stop`（模型自己结束）、`tool_calls`、
`max_tokens`、`refusal`（被拒/被过滤）、`error`。**先看这个再猜原因**。

完整清单在协议文档附录。

## 实现细节（从 README 搬来的，用户不需要知道）

### 模型目录的数据源

两个端点**并行**取，只用实时数据，没有本地模型表：

| 来源 | 角色 | 说明 |
| --- | --- | --- |
| `GET /console/enterprises/personal/models` | 定列表 | 账号维度，决定"这台账号有哪些模型" |
| `GET /v3/config` | 补字段 | 部署维度，补上 scoped 没写的等级集合、描述、倍率等 |

- scoped 成功 → 用它定列表，用 config 逐字段补空（同 id）；config 独有、scoped 没有的 id **不并入列表**（那些多是已下线条目）。
- scoped 失败 → 直接用 config（海外版当前的常态）。
- 两个都失败 → 用本地缓存；连缓存都没有才是空列表。
- 内存缓存 10 分钟；登录、退出、`/models?refresh=1` 会立即重取。

### 准入策略（哪些模型进列表）

按顺序判定，一条不满足即剔除：

1. **裸路由别名不进列表**：`auto`、`default`。能调通但官方选择器不展示；已被钉住的长会话仍可调用。
2. **路由预设两版都剔除**：`default-model`、`fast-model`、`balanced-model`、`primary-model`、`deep-model` —— 按请求临时挑后端、倍率浮动。
3. **白名单优先**：`agents[cli].models` 无条件保留。**两版白名单不同**，各读各自的 payload：国内 19/20 条，国际 28 条。
4. **白名单外必须有实时倍率**：`credits` 有值才留。倍率是"这个模型确实在售"的唯一凭据。
5. 非对话后端（`completion-*` / `codewise-*` / `nes-*` / `hunyuan-image*` / `kling-video*` / `minimax-video*`、`maxOutputTokens ≤ 256`、`tags` 含 `text-to-image`）一律剔除。

实测（2026-10-21）：国内 34 → **30**，国际 28 → **24**。

### 探测请求的形态（两个部署不同，不要互相套用）

| | 大陆版 | 海外版 |
| --- | --- | --- |
| 网关校验顺序 | **先解析模型，后校验参数** | **先校验请求形状**（空/首条非 system → `11128`） |
| 探测请求体 | `{"model":M,"messages":[],"stream":true}` | `{"model":M,"messages":[{system:""}],"stream":true,"max_tokens":1}` |
| 判定 | 活 → `11133`/`11151`；已下架 → `11102` | 可用 → `11151`/`11133`/`200`；无权限 → `11158`；已下架 → `11102` |
| 代价（各 8 次实测） | 积分 **0 变化** | 积分 **0 变化** |

海外版的关键是**空的 system 内容**：满足"首条必须是 system"的形状要求，又让大多数模型在生成前
就回 `11151 a message has empty content`（校验层拒绝，不派发给模型）。

`max_tokens: 0` **不是零消耗手段** —— 实测被当成"没设置"，照常生成 12 个 token。

### 判定与台账

- 判定表（`classifyProbe`）：`ok`(200·11133·11151·其它 4xx) / `dead`(11102) / **`denied`(11158)** /
  `busy`(429·6020) / `blocked`(11128) / `auth`(401·403) / `down`(5xx) / `error`。
- 面板呈现：**不可用**（红）= 仅 `11102`；**无权限**（橙）= `11158` + `11128`；
  **凭据失效**（橙）= `401/403`；其余进**未知**（灰），原始报文留在悬停里。
- 分组只看结论：`不可用模型` = dead/denied/blocked，其余（含未知、排队）留在可用组。
- 台账 `availability-<region>.json` 按 id 记 `{state, detail, at}`，新结果覆盖旧的、其它条目保留；
  不可用判定**有效期 12 小时**。同文件记 `lastSweepAt` 用于节流。
- **自学习**：真实对话里回 `11102`/`11158` 直接写台账并失效目录缓存，不额外花请求。
- 触发：打开面板自动一次（国内 10 分钟节流、国际 24 小时）；按钮=手动立即；`/workbuddy check`=全量。

### 目录缓存语义

`catalog-<region>.json`：

- **追加**：按 id 并入，新 id 加入、老 id 刷新，**这次没提到的保留**（上游答得少不会缩短列表）。
- **缺字段不覆盖**：新数据没带的字段保留旧值；`efforts` 与 `input` 取并集。
- **倍率不进缓存**：`credits` 是实时值，缓存不存、读时丢弃。
- **准入策略在读取时同样生效**（缓存是追加的，规则会变）。
- 写入原子（临时文件 + rename），旧快照留 `catalog-<region>.prev.json`。

### 上游行为与错误映射

退避重试**全部由 harness 负责**（`dsh-llm-retry`，默认 5 次、500ms 起指数退避 + 抖动、上限 10s）。
适配器只做两件**即时**补救，都不是退避重试：

1. `Illegal API invocation from an unapproved channel` → 换会话标识重发一次，仍失败则切备用聊天路由；
2. `401/403` → 先续期令牌再发一次。

适配器**不转发上游的 `retry_after`**：节拍只由一套策略掌握。

- **模型排队**：`429` + `6020` + i18n key `queue.waiting.title` + `data.queue_position`
  → 「模型排队中（队列第 N 位），将自动重试」，`RATE_LIMIT`。
- **用量频率超限**：`429` + `usage exceeds frequency limit…reset at <时间>` → `RATE_LIMIT`，
  文案里带重置时间与"期间可换其它模型"。
- **未获批渠道**：见不变量 11 与提示词改写。
- **模型不可用**：`11102` → `INVALID_REQUEST`，不重试。
- **401/403** → 先续期再重试一次；**5xx** → `SERVER`。

### 系统提示词改写

国内网关会把**以这句开头**的 system 消息判成"未获批渠道"（`code 11128`）：

```
You are an AI agent powered by DeepSeek Harness.
```

规则是**行首锚定、大小写不敏感、句末句点可选**的品牌指纹。适配器只把 `DeepSeek Harness`
改成 `this harness`，其余原样保留；海外版走同一条路径，避免两套形态。

## 代码与写作约定

- **代码与注释用英文**，面向用户的文案用中文，并在 `client/index.js` 的词典里给中英两份
  （`en` 与 `zh-CN` 必须成对，`client.mjs` 会检查）。
- 注释解释**为什么**，不解释"做了什么"；尤其是"看起来可以删、其实不能删"的地方要写明原因。
- 提交信息用祈使句英文，第一行说清动机，必要时在正文补原因与影响。
- 不要引入新依赖：宿主侧只用 Node 内置模块，客户端侧只用 React 与宿主提供的服务。

## 不要提交的东西

- `test/.token`（真实登录令牌，已在 `.gitignore`）；
- `$DSH_HOME` 下的任何缓存、台账、凭据；
- **任何真实账号事实**：昵称、账号 ID、余额、到期时间、cookie、会话 id。
  示例与 fixture 一律用假数据（`示例账号` / `900000001` 这种），
  `test/live/ui-preview.mjs` 与 `test/unit/client.mjs` 里的 fixture 就是模板。
- 提交前跑一次 `node test/live/leak-scan.mjs`；工作区必须是干净的。
  历史若曾经包含真实数据，发布时要用一份干净历史（见下）。

## 发布到 GitHub

本地 `main` 的早期提交里曾经含有真实账号事实（fixture 与示例），所以**不要直接推 `main`**。
发布用一份单提交的干净历史：

```sh
node test/live/leak-scan.mjs                 # 工作区必须干净
git checkout --orphan public && git add -A
git commit -m "dsh-workbuddy: <一句话>"
git checkout main                            # 保留本地完整历史
node test/live/leak-scan.mjs public          # 只扫发布分支：历史必须 0 命中
git push -u origin public:main               # 远端 main 由这份干净历史建立
```

之后继续在 `main` 上开发、发布时重建 `public`；或者干脆把 `main` 重置到干净历史上
（`git checkout main && git reset --hard public`），让唯一的本地历史就是公开历史。
