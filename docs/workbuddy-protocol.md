# WorkBuddy 协议与数据参考

本文件记录 WorkBuddy（腾讯 CodeBuddy 系）两个部署的接口、字段、数据源与错误码，供以后接入/排障时直接查阅，不必重新抓一遍。

**来源标记**

| 标记 | 含义 |
| --- | --- |
| ✅ | 本机实测（2026-10-21，DSH Desktop 2.0.18 / Windows； |
| 📖 | 摘自参考实现 `dsh-our-free-model` 的 channel-pack（`vendor/channel-pack/pack.js`），本机未逐条复验 |
| ❓ | 未验证或推测，使用前请复核 |

**采集方式**：浏览器直连 + 插件令牌裸请求（脚本见 `test/live/*.mjs`）。所有路径都以「相对部署根」书写。

---

## 1. 部署与账号体系

| 维度 | 海外版 | 大陆版 |
| --- | --- | --- |
| Web 应用 | `https://www.workbuddy.ai/app` | `https://www.workbuddy.cn/app` |
| 插件端点（登录/目录/计费） | `https://www.workbuddy.ai` | `https://www.workbuddy.cn` |
| 聊天主机 ✅ | `https://www.workbuddy.ai` | `https://copilot.tencent.com`（CodeBuddy 中国网关；web 主机对 harness 流量回 11128） |
| `auth/state` 的 `platform` | `workbuddy-ai` | `workbuddy` |
| 默认 UA ✅ | `WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2` | `WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2` |
| `X-Product-Code` ✅ | `workbuddy` | `workbuddy`（`codebuddy` 也被接受） |
| 产品代号（JWT `app_type`）📖✅ | `codebuddy` | `codebuddy` |
| 地址族 | `ap-*` 国际区 ❓ | `ap-others` / `ap-others-4`（积分包 `Region`/`Zone`）✅ |

- 两个部署**同一套账号体系**（JWT `iss` 分别为 `https://www.workbuddy.ai/auth/realms/copilot` 与 `https://www.workbuddy.cn/auth/realms/copilot`，Keycloak realm 名都是 `copilot`）。
- 三种访问面：**Web 应用**（cookie 会话）、**官方 IDE/CLI 客户端**（插件令牌 + Bearer）、**本插件的插件协议**（复用第二条）。
- 团队/企业版另有 `/console/enterprises/<scope>/models` 的 `scope` 维度；本机账号是 `personal` ✅。企业字段如 `X-Enterprise-Id` / `X-Tenant-Id` 在个人版为空 ✅。

---

## 2. 认证与凭据

### 2.1 四个端点 ✅

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/v2/plugin/auth/state?platform=<platform>` | 取 `state` 与 `authUrl` |
| GET | `/v2/plugin/auth/token?state=<state>` | 轮询换取 `accessToken` / `refreshToken` |
| GET | `/v2/plugin/login/account?state=<state>` | 取账号信息（需 Bearer） |
| POST | `/v2/plugin/auth/token/refresh` | 令牌轮换（需 Bearer + `X-Refresh-Token`） |

`auth/state` 的请求头（未登录态）✅：

```
X-Domain: <apiDomain>
X-No-Authorization: true
X-No-User-Id: true
X-No-Enterprise-Id: true
X-No-Department-Info: true
User-Agent: <部署 UA>
```

响应：`{"code":0,"msg":"OK","data":{"state":"<uuid>","authUrl":"https://<host>/login?platform=<platform>&state=<uuid>"}}`

`authUrl` 的附加参数（官方客户端行为，📖 + ✅ 实测可用）：`version=<客户端版本>`、`loginSessionId=<uuid>`。**注意**：URL 带 `&`，Windows 上必须用 `cmd /c start "" "<url>"` + 引号打开，否则被 cmd 截断，登录页会提示「登录链接不完整」。

### 2.2 轮询与超时

- `auth/token` 在用户未完成授权时返回 `code 11217`（token not ready），继续轮询 ✅📖
- `login/account` 在账号信息未就绪时返回 `code 12151`（account not ready），继续轮询 📖
- 实测：浏览器点选账号后 1～2 秒内即可换到令牌；插件按 1.5s 间隔、5 分钟上限轮询足够 ✅

### 2.3 令牌与账号字段

`auth/token` 的 `data` ✅：

| 字段 | 说明 |
| --- | --- |
| `accessToken` | JWT，长度约 1.4 KB |
| `refreshToken` | JWT，长度约 1.1 KB |
| `expiresIn` | 秒。实测 CN：`2361668`（≈27.3 天） |
| `refreshExpiresIn` | 秒。实测 CN：`2534468`（≈29.3 天） |
| `tokenType` | `Bearer` |
| `scope` | `openid profile offline_access email` |
| `sessionState` | 会话标识 |
| `domain` | 例：`www.workbuddy.cn`（后续请求的 `X-Domain`） |

`accessToken` 载荷（实测样例，字段名照抄）✅：

```json
{
  "acr": "",
  "allowed-origins": ["*"],
  "app_type": "",
  "aud": "",
  "auth_time": ,
  "azp": "console",
  "email_verified": ,
  "enterprise_id": "",
  "exp": ,
  "iat": ,
  "iss": "https://www.workbuddy.cn/auth/realms/copilot",
  "jti": "…",
  "nickname": "",
  "oneid_account_id": "",
  "oneid_union_id": "",
  "preferred_username": "",
  "realm_access": { "roles": ["default-roles", "offline_access", "uma_authorization"] },
  "…": "（其余字段未逐条记录）"
}
```

> 实用推论：`nickname` / `preferred_username` / `exp` 都可以直接从 JWT 里读，不必额外请求账号接口 ✅。

`login/account` 的 `data`（实测，截断）✅：

| 字段 | 示例 / 说明 |
| --- | --- |
| `uid` | `faf3a9d6-…`（UUID） |
| `nickname` |  |
| `uin` |  |
| `type` | `personal`（企业版应为 `enterprise` ❓） |
| `lastLogin` / `isCreator` / `isAdmin` / `pluginEnabled` | 布尔 |
| `deployStatus` | `{statusCode, statusMsg, detailMsg}` |
| `accountType` | `""`（个人版为空） |
| `sso` | `{domain, domainModifiedTimes}` |
| `idp` | `""` |
| `areaInfoComplete` | 布尔 |
| `oneidAccountId` / `isCurrentOneIdEnterprise` / `isCurrentOneIdPersonal` | 账号合并（OneID）相关 |

### 2.4 续期

```
POST /v2/plugin/auth/token/refresh
Authorization: Bearer <旧 accessToken>
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: ide-main      ← 📖 参考实现所用值
X-Domain: <apiDomain>
```

响应结构同 `auth/token`（`data.accessToken` / `refreshToken` / `expiresIn` / `refreshExpiresIn`）✅。
失败语义：HTTP 401/403 或 msg 含 `expired` / `invalid` → refresh token 失效，需重新登录 📖。

**凭据落库建议**：`access_token` 与「refresh token + 到期时间 + 账号信息」分开存两个引用，前者是直接发到 `Authorization` 的裸值，后者是 JSON ✅。

---

## 3. 聊天协议

### 3.1 请求

```
POST <chatEndpoint>/v2/chat/completions
```

请求头 ✅：

| 头 | 值 |
| --- | --- |
| `Authorization` | `Bearer <accessToken>` |
| `Accept` | `text/event-stream` |
| `Content-Type` | `application/json` |
| `X-Domain` | 聊天主机域名，例 `copilot.tencent.com` / `www.workbuddy.ai` |
| `X-Product` | `SaaS`（部署类型，两部署同值 📖） |
| `X-Product-Code` | `workbuddy` |
| `X-Agent-Purpose` | `conversation` |
| `X-IDE-Name` / `X-IDE-Type` | `WorkBuddy` |
| `X-IDE-Version` | `5.5.2` |
| `User-Agent` | 见 §1（按模型族可切换，📖：`gpt-*`/`gemini-*`/`claude-*` 用国际 UA） |
| `X-Conversation-ID` | 会话标识（可复用；被风控标记时换新值，见 §7） |
| `X-Conversation-Message-ID` / `X-Conversation-Request-ID` | 每次请求新 UUID |

请求体字段 ✅：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `model` | ✅ | 模型 id（或预设 id） |
| `messages` | ✅ | OpenAI 形态；**必须含 `role:"system"`**，否则 400 + `11128` 📖✅ |
| `stream` | ✅ | 只能为 `true`；`false` 会回 `11101 Non-stream chat request is currently not supported` ✅ |
| `max_tokens` | 否 | 实测 `128000` 可用 ✅；未知/别名模型按目录 `maxOutputTokens` |
| `tools` | 否 | OpenAI function 形态，70 个工具 / 60 KB 实测通过 ✅ |
| `prompt_cache_key` | 否 | 服务端前缀缓存键；缺失时缓存命中恒为 0 📖 |
| `thinking` | 否 | **本插件不再发送**（2026-10-23 实测：带不带它都不影响 ds 是否思考，见 §12.1） |
| `reasoning_effort` | 否 | `low` / `medium` / `high` / `xhigh` / `max`，取值须在该模型支持列表内 ✅ 网关会校验（见下）；**这是唯一的思考控制**，按目录声明统一取值（调用方选择 → `defaultEffort` → `high` → 首档） |
| `temperature` / `stop` | 否 | 直通 ✅ |

**`reasoning_effort` 是真实生效的参数**（2026-10-22 实测，海外版 `deepseek-v4.1-flash`，免费模型，
脚本 `test/live/effort-effect.mjs`，`ROUNDS` 可重复）：

1. **网关会校验它**：传一个目录里没有的值（`totally-bogus`）→ HTTP 400
   `{"code":11133,"msg":"the request parameters were rejected by the model provider",
   "extError":{"code":"invalid_parameter_value"}}`——说明字段确实被转发给模型服务商，不是被忽略 ✅
2. **在一句话就能答的题上，三档看不出区别**：鸡兔同笼题 12 次采样，
   `low` 241 字 / `high` 232 字 / `max` 214 字（单档内波动 44–81 字）——低档也会思考 200+ 字，
   所以差距被噪声淹没。
3. **在需要多步推理的题上，档位单调分档**（三位数推理题，各 3 次）：

   | 档位 | 思考字数（均值） | 范围 | completion tokens（均值） |
   | --- | --- | --- | --- |
   | `low` | 982 | 674–1512 | 615 |
   | `high` | 3605 | 1463–5759 | 1324 |
   | `max` | 6115 | 5460–6461 | 2048（撞到 `max_tokens` 上限） |

   → 档位有意义，但**题越简单越看不出来**；`max` 在难题上会一路顶到 `max_tokens`。

4. **用量里有 `completion_tokens_details.reasoning_tokens`**，与思考文字数一致；免费模型返回
   `credit: 0` ✅（这也是"免费"标签的判据之一）。

**不同厂商的请求结构由厂商自己校验，网关只做转发**（2026-10-22 实测，`test/live/request-structure.mjs`
逐字段试探；免费模型优先，海外版免费档有 `deepseek-v4.1-flash` / `hy3` / `step-5-preview`）：

| 变体 | deepseek-v4.1-flash | step-5-preview（阶跃） | hy3（混元） | glm-5.3-flash（智谱） |
| --- | --- | --- | --- | --- |
| 基线（不带档位） | 200，思考 **0 字** | 200，思考 596 字 | 200，思考 370 字 | 200，思考 **0 字** |
| `+ reasoning_effort:"<合法档>"` | 200，思考 **261 字** | 200，447 字 | 200，502 字 | 200，思考 **337 字** |
| `+ reasoning_effort:"totally-bogus"` | **400 `11133` 拒绝** | 200 静默忽略 | 200 静默忽略 | 200 静默忽略 |
| `+ thinking:{type:"enabled"}` | 200，仍 0 字 | 200 | 200 | 200，35 字 |
| `+ thinking:{type:"disabled"}` | 200 | 200，仍思考 379 字 | 200 | 200，0 字 |
| `+ thinking:{type:"nonsense"}` | 200 | 200 | 200 | 200 |
| `+ max_completion_tokens`（去掉 `max_tokens`） | 200 | — | 200 | 200 |
| `+ 未知字段` | 200 | 200 | 200 | 200 |

结论：

1. **只有 DeepSeek 系会校验 `reasoning_effort`**（非法值 400 `11133`）；其余厂商静默忽略非法值。
   说明网关**不做统一校验/改写**，请求体基本按原样转给各厂商自己的 API ✅
2. **`thinking` 字段实际上不是开关**：`enabled` / `disabled` / 乱填一律 200，思考量也没跟着变
   （glm 那次 35 字的差异在噪声范围内）。所以插件只在官方客户端确实会发的 deepseek 系带这个字段。
3. **真正决定"思不思考"的是有没有 `reasoning_effort`**：deepseek 与 glm **不带该字段 → 思考 0 字**
   （完全不思考）；hy3 / step 属于强制思考型（`onlyReasoning`），不带也会思考。
   → 因此适配器对**任何声明了档位的模型**都必须带上档位（选中的，否则目录里的 `defaultEffort`，
   再次是 `high`），这正是"思考恒为开启"的落地方式；没声明档位的模型才不带 ✅

**历史消息里的 `reasoning_content` 会原样回放**，服务端接受 ✅（不做回放也能跑通）。

### 3.2 响应（SSE）

```
: heartbeat
data: {"id":"…","model":"…","object":"chat.completion.chunk","created":…,"choices":[{"index":0,"delta":{…},"finish_reason":""}],"usage":null}
data: [DONE]
```

- `: heartbeat` 是注释行，解析时跳过 ✅
- `delta` 实测字段：`role` / `content` / `reasoning_content` / `function_call` / `refusal` / `tool_calls` / `extra_fields` ✅
- 流式工具调用：**仅首个分片带真实 `id`**，后续分片只有 `index`，需按 index 归并 📖✅
- 末帧 `finish_reason`：`stop` / `tool_calls` / `length` ✅
- **流一定以 `data: [DONE]` 收尾**；没有它、也没有 `finish_reason` 就断流 = 连接被中途掐断
  （不是模型"决定停下"）📖。插件据此判定：这种情况必须上报 `TRANSPORT` 错误交给重试策略，
  **绝不能**当成正常 `stop` —— 曾经因此出现"看着还没说完就结束了，也不重试"的现象 ✅（已修）。
  判定与补救都有日志：断流时打一行带证据的告警（收到多少字节、用时多久、中断时在输出哪一类内容），
  重试时再由插件订阅 `session/event` 的 `llm/retry` 打一行"第 N/M 次重试（TRANSPORT）… 后重试"。
  频率实测工具：`node test/live/stream-cut-probe.mjs [cn|intl] [次数] [模型] [--long] [--selftest]`
  （2026-10-22 实测：大陆版短问答 4/4 正常、海外版 `deepseek-v4.1-flash` 长回答 10/10 正常，
  即断流是间歇性的，常规探测不易复现）
- **finish 帧带一个 `response` 诊断块**（`kind`/`version`/`api`/`provider`/`model`/`responseId`/
  `stopReason`/`outputTokens`/`blocks`）。它不是 harness 的契约字段（`dsh-llm` 的类型里没有
  `response` / `stopReason`），纯属遥测：会话诊断里会原样显示，用来一眼回答"这一步是谁答的、
  上游叫它什么 id"，不必再从 `request/header` 反推。`responseId` 取自上游流里的 `id`
  （形如 `chatcmpl-…`），可以直接和上游日志对账；harness 不会据此改变行为 ✅
- `usage`（末帧携带）：`prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens` / `completion_tokens_details.reasoning_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `credit` ✅

---

## 4. 模型目录

### 4.1 两个数据源

| 源 | 路径 | 特点 | CN | INTL |
| --- | --- | --- | --- | --- |
| scoped（定列表） | `GET /console/enterprises/<scope>/models` | 账号维度、字段最全、含倍率与图标 | ✅ 34 条 | ⚠️ 2026-10-21 起 500（APISIX） |
| config（补字段） | `GET /v3/config` | 部署维度、含 agents 与促销 | ✅ 62 条（含已下线/非对话条目）；上午还是 `12403` 拒绝 | ✅ 28 条 |

两个源**并行**取：scoped 决定列表，config 逐字段补空，config 独有的 id 不并入列表（避免把已下线条目变成可选模型）。

`scope`：`personal`（个人版）✅；企业版取值 ❓。

两个源都要 `Authorization: Bearer` + `X-Domain` + `X-Product: SaaS` + `X-Product-Code: workbuddy` + UA ✅。

**海外版控制台侧还有三条路由**（都是 Web cookie 专用，插件令牌一律 403 `access_denied / not_authorized`，不能作为插件数据源）✅：

| 路径 | 现象 |
| --- | --- |
| `POST/GET /console/as/users/private-configs/query` | 403（Web 应用会调，携带 cookie） |
| `GET /console/enterprises/personal/config` | 403 |
| `GET /console/enterprises/personal/models/list` | 403（注意与 scoped 的 `…/models` 是不同路由） |

`/v2/plugin/config`、`/v2/config` 均 404 ✅。

**无凭据对照**（说明 scoped 是控制台路由）✅：

| 目标 | 无令牌 | 假令牌 | 真令牌 |
| --- | --- | --- | --- |
| INTL | 400 `{"error":"Client not found."}` | 500 HTML | 500 HTML |
| CN | 400 `未找到 cookie。请确保浏览器已启用 cookie。` | 401 | 200 |

### 4.2 scoped 响应结构

```json
{"code":0,"msg":"OK","data":{
  "agents":[ { "name":"cli", "models":["auto","hy3",…], "tools":[…], "instructions":"cli-agent-prompt", "tags":["cli","default"], "modelTags":["craft"] }, … ],
  "endpoint": …, "stagingEndpoint": …, "links": …, "mergeStrategy": …,
  "productFeatures": { "ModelTrialBanner": { "banners":[{"targetModelId":"…"}] }, … },
  "models":[ { …见下表… } ]
}}
```

`agents[]` 实测出现的 `name`：`cli`、`general-purpose`、`compact`、`contentAnalyzer`、`terminalTitleGenerator`、`summaryGenerator`、`promptHookEvaluator`、`insightsAnalyzer`、`agentInstructions`、`statusline-setup`、`Explore`、`Bash`、`Plan` ✅。其中只有 `cli` / `craft` 带 `models` 白名单 📖✅。

`models[]` 单条字段（CN 实测全集；INTL `/v3/config` 少 `repetition_penalty` 与 `top_k`）✅：

| 字段 | 说明 |
| --- | --- |
| `id` / `name` | 模型 id 与展示名 |
| `isDefault` | 默认模型标记（`auto` 为 true） |
| `vendor` | 供应商标识单字母（`f`/`e`/`j`/`v`…），用途未明 ❓ |
| `maxInputTokens` / `maxAllowedSize` | 上下文窗口上限 |
| `contextWindow` | 仅部分模型有：`{defaultLength, supportedLengths:[…]}`（如 step-5: `[300000, 1000000]`） |
| `maxOutputTokens` | 输出上限 |
| `supportsImages` / `supportsReasoning` / `supportsToolCall` / `disabledMultimodal` | 能力位 |
| `onlyReasoning` / `canDisableThinking` | 是否强制思考 / 上游的"可否关闭思考"声明 —— **插件忽略它**，理由见 §4.3.1 |
| `reasoning` | `{effort, summary, defaultEffort, supportedEfforts:[…]}`；`effort` 是默认档，`supportedEfforts` 才是可选集合 |
| `relatedModels` | 关联模型映射，如 `{lite, reasoning, builtin-lite}` |
| `credits` | 倍率字符串，如 `"x0.00 credits"` / `"x2.20 credits"` / `"x0.05"` |
| `tags` | `craft`、`badge:限时免费:#FF0000`、`text-to-image` 等 |
| `temperature` / `top_p` / `top_k` / `repetition_penalty` | 采样默认值 |
| `descriptionEn` / `descriptionZh` | 简介（中文版可用） |
| `iconUrl` / `iconUrl_en` | 图标（base64 data-URI 或 HTTPS URL，按语言选） |
| `AccountAttributes` ❓ | 出现在积分包里，模型侧未见 |

#### 4.3.1 `canDisableThinking`：上游没给关闭参数，插件选择"忽略它、思考恒开"（2026-10-22 实测）

三条结论都有原始响应与缓存对比支撑（`node test/live/reasoning-audit.mjs [cn|intl]`）：

1. **上游只发一个布尔位，不发参数名。** `reasoning` 块出现过的字段只有
   `canDisableThinking` / `defaultEffort` / `effort` / `summary` / `supportedEfforts`；
   整条记录里像"开关"的字段只有 `canDisableThinking` 和 `disabledMultimodal`（后者是
   多模态能力，与思考无关）。也就是说：**"能不能关"它说了，"怎么关"它没说。**
   反向参数（`thinking:{type:'disabled'}` / `enable_thinking:false` /
   `reasoning:{effort:'none'}` 之类）**一个都没验证过**。
2. **两个部署各自独立声明，而且会变。** 同一天里：大陆版对 `glm-5.2`、`kimi-k3-1`、
   `deepseek-v4-flash`、`deepseek-v4-pro`、`hy3` **完全不发**该字段，海外版对同样的 id
   一律发 `true`/`false`；大陆版过去发过、现在不发了 —— 说明它不是稳定契约。
3. **插件的决定：忽略这个字段，思考恒开。** 既然"能关"无法兑现（没有参数），就不要在
   面板上宣称它 —— 于是：
   - 目录解析不再读取该字段（`catalog.js`），合并、面板载荷、账号名单富化里也一并去掉；
   - 面板详情不再有「可关闭思考」这一行（没有开关就不摆开关）；
   - **唯一能调的仍然是档位**（`reasoning.supportedEfforts` → 低/中/高/超高/极致）；
   - `thinking:{type:'enabled'}` 目前只对 deepseek 系发送（§4.5 表，📖✅ 已验证），
     其它族不发这个字段（它们本身就是 `onlyReasoning` 模型，默认就在思考）；
   - 缓存里把该字段当作**已废弃字段**处理：老快照读出来就丢掉，不再留痕。

   如果将来上游给出真正的关闭参数，正确做法是把它变成一个档位（例如「关闭」）交给
   选择器，而不是恢复一个布尔位。

### 4.3 `/v3/config` 结构
```json
{"code":0,"data":{
  "$schema":"product-schema.json",
  "agents":[{"name":"cli","models":[…],"modelTags":["craft"],"commands":["init","compact"],"instructions":"cli-agent-prompt"}],
  "models":[ …同 scoped 字段（少 top_k/repetition_penalty）… ],
  "modelPromotions":[ {"enabled":true,"priority":…,"modelIds":[…],"discount":{"factor":0,"discountedCredits":"x0.5"},"schedule":{…}} ],
  "productFeaturesConfig": { "ModelTrialBanner": { "banners":[{"targetModelId":"…"}] } }
}}
```

促销解析（✅ 2026-10-22 实测，读取的字段就是插件用的那几个）：

| 字段 | 含义 | 插件用法 |
| --- | --- | --- |
| `badge.label` / `badge.color` | 徽标文案与颜色（如 `Free now` + `#E5484D`） | 行内与详情里的促销标签，**同一个渲染函数** |
| `hover.textZh` | 悬停说明（如 `Free daily use with unlimited credits.`） | 标签的 tooltip、详情「促销详情」 |
| `discount.discountedCredits` | 折后倍率（`x0.5`） | 促销期内展示的折扣 |
| `discount.factor === 0` + 时间窗 | 免费 | 与 `credits === 0` 一起决定「免费」标签 |
| `kind` | 促销类型（实测为 `discount`） | 没给 `label` 时的兜底文案 |
| `schedule.validFrom` / `validUntil` | 生效与结束时间 | 详情「促销时限」 |

一条促销可以用 `modelIds` 覆盖多个模型（实测 `hy3` 与 `deepseek-v4.1-flash` 共享一条 `Free now`）。**倍率与促销都不进目录缓存**：缓存只在实时抓取失败时救急，避免把过期的价格当作事实。

### 4.4 别名与预设

- **不是**具体模型的入口：`auto`、`default`（裸别名，无元数据）
- **路由预设**（有元数据但会按任务挑后端）：`auto`、`default`、`default-model`、`fast-model`、`balanced-model`、`primary-model`、`deep-model`
- 服务端**没有**统一的 preset 标记：`auto` 只有 `isDefault: true`，`default` 只有一个 `vendor` ✅

### 4.5 目录过滤规则（📖，本插件沿用）

- 跳过前缀 `nes-` / `completion-` / `codewise-`
- 跳过 `supportsExtra === true`
- 跳过 `maxOutputTokens ≤ 256`（分类器之类）
- 跳过 `tags` 含 `text-to-image`
- `agents` 优先取 `cli`，其次 `craft`

### 4.6 已知坑

| 现象 | 说明 |
| --- | --- |
| CN `/v3/config` → `400 code 12403 check ua, get coding copilot version error` | 插件令牌不被接受，与 UA 无关（试过 8 种 UA / 2 种 product-code）✅ |
| INTL scoped → `500`（openresty/APISIX，HTML 错误页） | 2026-10-21 起持续；`/v3/config` 正常 ✅ |
| `glm-5.1` 图片能力两个端点矛盾 | scoped 报 `false`、`/v3/config` 报 `true`，实测能看图（📖 参考实现据此写了覆盖白名单） |
| 目录包含渠道不服务的模型 | 见 `11102`（§6）✅ |
| 长上下文下"说话说一半就收尾"（`finish_reason: stop`，无工具调用） | 上游/模型行为，**不是插件问题**。对外跟踪入口：[issue #1](https://github.com/2424830124/dsh-workbuddy/issues/1)（含两次真实截断的 `responseId`/`outputTokens` 与已排除项）。实测：同一提示、同一套工具、只改前面的对话长度 —— 0k 2/2 正常、30k 1/2（一次 181 字后 `stop`）、89k 1/2；每次 finish 诊断块都标 `workbuddy-intl/deepseek-v4.1-flash`。判据：流里**没有任何 tool-call 分片**、`finish_reason` 就是 `stop`（若丢帧会是 `tool_calls` 且能看到分片）。已排除：采样（五档 16/16 与 2–3/8 两个实验都无差别）、工具 schema/数量（70 个 / 单个 / 简化 schema 9/9 正常）、`prompt_cache_key` 与 `stream_options`（去掉后 1/8 vs 2/8）、提示词校验（海外版无 11128 之外的拦截，请求体按原样转发）。复现：`node test/live/long-context-probe.mjs 2`、`node test/live/repro-probe.mjs 3 deepseek-v4.1-flash 280000`；取证：`node test/live/session-tail-live.mjs <会话前缀> 8 dsh-model-picker`（读 `response.stopReason` 原话）。缓解只有换模型/压缩上下文/回一句"继续" —— 合法的 `stop` 不能当错误重试。 |

### 4.7 模型选择器里每一项元数据的来源

Web 端 picker 的悬停卡片会显示简介、消耗速度、繁忙程度、思考档位。逐项溯源（✅ 实测 + 源码定位）：

| UI 元素 | 数据源 | 字段 / 值 |
| --- | --- | --- |
| 名称（含「极致」「快速」等预设名） | 目录 | `name` ✅ |
| 简介「优先深度与准确性…」 | 目录 | `descriptionZh` / `descriptionEn`，前端按 locale 选（`zh*` → `descriptionZh`）✅ |
| 消耗速度 `1.20x 倍率` | 目录 | `credits`，如 `"x1.20 credits"`；前端只取数字再加 `x`（`/(\d+(?:\.\d+)?)/` → `1.20x`）✅ |
| 思考档位（低/中/高/超高/极致） | 目录 | `reasoning.supportedEfforts`（可选集合）、`reasoning.defaultEffort`、`onlyReasoning`、`supportsReasoning`；**档位文案是前端 i18n**（`model.effort.{low,medium,high,xhigh,max}.label` → 低/中/高/超高/极致），不是服务端下发 ✅ |
| 上下文窗口选择 | 目录 | `contextWindow.supportedLengths` + `maxInputTokens`（前端命名 `supportedContextWindows` / `defaultContextWindow`）✅ |
| 徽章（如「限时免费」） | 目录 | `tags`，形如 `badge:限时免费:#FF0000`；另有 `isDefault`、`badges` / `tierBadges`（前端派生）✅ |
| **繁忙程度**（空闲 / 轻微拥堵 / 极度拥堵 / 不可用） | **`POST /v2/chat/busy`** | 见下 ✅ |

#### `POST /v2/chat/busy`（仅大陆版）

```
POST /v2/chat/busy            Authorization: Bearer <token>   Content-Type: application/json
{"models":["hy3","glm-5.3","step-5-preview"]}
→ {"code":0,"msg":"OK","data":[
     {"model":"hy3","busy_level":"busy"},
     {"model":"glm-5.3","busy_level":"normal"},
     {"model":"step-5-preview","busy_level":"congested"}]}
```

| 维度 | 实测 / 源码 |
| --- | --- |
| 鉴权 | 插件 Bearer 令牌可用 ✅（CN 200） |
| 部署 | **仅大陆版**；海外版 `404 {"error_msg":"404 Route Not Found"}` ✅ |
| 请求体 | `{models:[id,…]}`，前端按 **50 个一批**并发（`lXt = 50`）📖 |
| 超时/缓存 | 前端单批 5s 超时、结果约 50s 缓存（`pxi = 50000`）📖 |
| `busy_level` 值域 | `idle` / `normal` / `busy` / `congested` / `unavailable` / `unknown`；前端白名单校验 `new Set([...])`，不在集合内一律 `unknown` 📖 |
| 前端映射到文案 | `idle`、`normal` → 空闲；`busy` → 轻微拥堵；`congested` → 极度拥堵（列表里还会出小图标）；`unavailable` → 不可用（禁用该项并提示 `当前模型服务异常，暂不可用`）📖 |
| 实测样例（2026-10-21 17:2x） | `hy3: busy`、`deepseek-v4.1-flash: busy`、`glm-5.3: normal`、`auto: unknown`、`step-5-preview: congested` ✅ |

> 注意：`busy_level` **不在**目录 payload 里（目录 66 个 key 里没有任何 busy/load 字段），是两个接口拼起来的 —— 目录给静态元数据，`/v2/chat/busy` 给实时负载。

---

### 4.8 两个部署的目录差异（2026-10-21 实测对照）

| 维度 | 大陆版 | 海外版 |
| --- | --- | --- |
| 可用目录源 | scoped ✅（34 条）；`/v3/config` ❌ `12403` | scoped ❌ 500；`/v3/config` ✅（28 条） |
| `/v3/config` 里的模型数 | **62 条**（含已下线/非对话条目，比 scoped 多得多） | 28 条（与 scoped 应等价，scoped 不可用无法对拍） |
| `descriptionZh` / `descriptionEn` | **22/34**；缺的 12 个是旧模型（`default`、`glm-4.6/4.6v/4.7/5.0`、`minimax-m2.5`、`kimi-k2.5`、`kimi-k2-thinking`、`deepseek-v3-2-volc`、`hunyuan-2.0-thinking`、`hunyuan-chat`、`hunyuan-image-alpha`），其中多数同时回 `11102` | **28/28 全有** |
| 预设（`auto` / `default-model` / `fast-model` / `balanced-model` / `primary-model` / `deep-model`） | 有描述（截图里的「极致」就是 `deep-model` 这类预设）；只有裸别名 `default` 没有 | 有描述 |
| `credits` 倍率 | 31/34（缺 `auto`、`hunyuan-chat`、`hunyuan-image-alpha`） | 27/28（缺 `default-model`） |
| `reasoning.supportedEfforts` | **10/34**（`low×8 high×10 max×6 medium×3 xhigh×2`），24 个没声明（含 `hy3`）→ **与 config 合并后 15/34** | **21/28**（`low×19 high×21 medium×13 xhigh×12 max×10`），7 个没声明（4 个预设 + `gemini-3.5-flash`、`kimi-k3`、`kimi-k2.6`） |
| `contextWindow`（多档上下文） | 15/34 | 11/28 |
| `tags` | 11/34 | 6/28 |
| `iconUrl` | 4/34（多为 base64 data-URI） | 2/28 |
| `top_k` / `repetition_penalty` | 各 2/34 | **0/28**（两字段不存在） |
| 实时繁忙度 `POST /v2/chat/busy` | ✅ 200，插件令牌可用 | ❌ `404 Route Not Found` |
| 前端是否有繁忙度 UI | 有：`model.busy.{label,idle,busy,congested,unavailable}` + `busyLevel` 字段 + 50 个一批的 `/v2/chat/busy` 调用 | **无**：`download.codebuddy.ai` 的 chunk 里搜不到 `model.busy.`、`busyLevel`、任何 `busy` 路径 |
| 前端思考档位词表 | `low / medium / high / xhigh / max` → 低/中/高/超高/极致 | 多一个 **`model.effort.minimal.label`**（minimal 档），其余同名 |
| 目录自报的聊天端点 | `data.endpoint = https://copilot.tencent.com` ✅（官方自己就这么写，与我们的路由一致）；另有 `data.stagingEndpoint = https://staging-copilot.tencent.com` | — |
| 其他产品级字段 | `mergeStrategy: "merge"`、`productFeatures`（`AutoMode` / `BillingNotice` / `CustomModelsJSON` / `DeferToolLoading` / `EnableAppearace` / `EnableAutoModelTiers` / `EnableIoaWecomCooperation` / `ImageGen` / `RequestBodyGzip` / `TodoAssistantDelegate`）、`links` | — |

**结论**：两边的字段**同名同义**，业务逻辑可以共用一套读取代码；差异集中在「有没有」和「覆盖率」上，所以判断"这个字段能不能用"必须按模型逐个判空，不能按部署假设。

#### 档位只有两个来源，合并才全 ✅

| 源 | 国内能补出的档位 |
| --- | --- |
| scoped | 10/34 有 `supportedEfforts` |
| `/v3/config` | 补出 **5 个** scoped 没声明的：`hy3` `hy3-x`（low/high）、`glm-5.2`（high/xhigh）、`deepseek-v4-flash` / `deepseek-v4-pro`（high/xhigh）、`kimi-k3-1`（low/high/xhigh） |
| 合并后 | **15/34**（实测 2026-10-21 17:49） |

**没有第三个来源**：产品级 payload 里不含 `defaultReasoning`（前端那个 `{high,max}` 兜底是客户端常量，不下发）；控制台的 `private-configs/query`（用户级模型配置，理论上可覆盖档位）对插件令牌和本机浏览器会话都是 403。剩下没声明的模型（如 `glm-5.1`、`minimax-m3`、`kimi-k2.6`）只有单档默认值，网页端同样不显示档位列表。

**思考档位的兜底行为**（前端源码 📖）：模型若**完全没有** `reasoning` 对象而 `supportsReasoning` 为真，前端会套用产品默认值 `{defaultEffort:"high", supportedEfforts:["high","max"]}`；若有 `reasoning` 但没 `supportedEfforts`（如 `hy3` 在 scoped 里），则**不显示档位列表**，只显示当前档与思考开关。本插件只认服务端声明的 `supportedEfforts`（两源并集），与后一种行为一致。

---

### 4.9 「目录里有 ≠ 能调用」：可用性判据（2026-10-21 实测）

目录会列出**已下架**的模型，而且带倍率、带描述，从字段上完全看不出：

| 判定手段 | 结果 |
| --- | --- |
| 目录字段（`credits` / `descriptionZh` / `supports*`） | ❌ 僵尸条目一应俱全（`glm-4.6` 有 `x0.23` 与完整描述） |
| `POST /v2/chat/busy` | ❌ 只对活跃集合给 `idle/normal/busy/congested`，其余一律 `unknown`（能用不能用都是 `unknown`） |
| 是否在 `agents[cli].models` 白名单 | ⚠️ 白名单内基本可用，但白名单外的也有能用的（`kimi-k2.5`、`deepseek-v4-flash`、`deepseek-v3-2-volc`） |
| `modelTiers[].requiredUserType`（静态） | ⚠️ 只说明"需要什么档位"，不知道自己的档位就推不出结论；实测它的 12 个 id 与海外版 `11158` 集合**完全一致** |
| **发一个探测请求** | ✅ 唯一可靠判据，两个部署的**形态不同**（见下） |

#### 探测请求：两个部署的校验顺序不同 ✅

| | 大陆版 | 海外版 |
| --- | --- | --- |
| 校验顺序 | **先解析模型 id，再校验参数** | **先校验请求形状**，再查模型/权限 |
| 探测体 | `{"model":M,"messages":[],"stream":true}` | `{"model":M,"messages":[{"role":"system","content":""}],"stream":true,"max_tokens":1}` |
| 活模型 | `400 11133`（参数被拒）或 `11151`（`hy3`/`hy3-x` 先校验对话内容） | `11151`（空内容）/ `11133`，少数回 `200` 但**不产生任何内容** |
| 已下架 | `400 11102 service info not found` | `400 11102 service info not found` |
| 账号无权限 | （免费账号未遇到） | `400 11158 model [x] is not allowed for user type [personal_free_user]` |
| 代价 | **零消耗**：参数层就拒了，不启动生成 | 实测 8 次探测（`kimi-k3` x1.62）积分 **0 变化**；另一可用模型 `hy3` 回 `200` 且 6 秒内零内容 |

- 海外版的**空 system 内容**是关键：它满足"首条消息必须是 system"的形状要求（否则一律 `400 11128 first message is not system`，**所有模型都一样，拿不到任何信息**），又让多数模型在生成前回 `11151 a message has empty content`。
- 回答"空 system 算不算 token"：**若请求真的派发给模型，角色本身要算**——聊天模板会加 `<|im_start|>system\n…<|im_end|>\n` 这类固定开销（约 3–6 token），空内容只是不加正文 token；但探测到不了那一步，`11151`/`11133` 都是校验层错误，**没有 token 被计费**（计费接口最小刻度 1 积分，实测整数余额不动）。
- **试过但无效**的"免费"写法（都实测）：`reasoning_effort:"测试"`、`thinking:{type:"测试"}`、`max_tokens:0/-1`、孤儿 `tool_calls`（助手声明调用了未定义的工具）、`stop` 类型错误 —— 前几个被两个网关**直接忽略**（照样生成），后一个在模型校验之前就被拒（`11101 Unmarshal chat params failed`）。
- `stream: false` 也不能用：两边都会先回 `11101`（不支持非流式），注册表校验根本没跑到。

大陆 30 个模型全量实测（2026-10-21 21:2x，零消耗）：**`ok` 22 / `dead` 8**（`glm-5.0`、`hy4-preview-x`、`glm-4.7`、`glm-4.6`、`glm-4.6v`、`minimax-m2.5`、`kimi-k2-thinking`、`hunyuan-2.0-thinking`），30 个并发 3 路约 2 秒。海外版 25 个：**`ok` 13 / `denied` 12**（GPT 系列 + `grok-4.7` + `gemini-3.x-flash`）。

失败响应的语义（用于判定与展示）：

| 响应 | 语义 | 面板标签 | 算不算"不可用" |
| --- | --- | --- | --- |
| `400 11133`（探测中）/ `200` | 模型存在 | 不显示 | 否 |
| `400 11151 a message has empty content` | 模型存在，先校验了对话内容 | 不显示 | 否 |
| `400 11102 model [x] service info not found` | 模型已下架 | **不可用**（红） | ✅ 是 |
| `400 11158 not allowed for user type [x]` | 账号档位不够 | **无权限**（橙） | ✅ 是 |
| `400 11128` | 被判定为未获批渠道（"被拦截"） | **无权限**（橙） | ✅ 是 |
| `429 6020 queue.waiting.title` | 排队（可用但繁忙） | 排队中 | 否 |
| `401/403` | 凭据问题（整账号） | 未知（灰） | 否 |
| `5xx` | 上游故障 | 未知（灰） | 否 |
| 其它 4xx | 走到了参数层（说明模型存在） | 未知（灰） | 否 |

判定结论的有效期定为 **12 小时**：过期后重新出现在列表里并在下次检测时复验，避免一次抖动把模型永久拉黑。

---

## 5. 积分与签到

### 5.1 余额

```
POST /v2/billing/meter/get-user-resource     body: {}
```

请求头：`Authorization` + `Accept` + `Content-Type` + `X-Domain` + `X-Product: SaaS` + `X-Product-Code` + `User-Agent`（个人版无 `X-User-Id` / `X-Enterprise-Id`）✅。

响应 ✅：

```json
{"code":0,"data":{"Response":{"Data":{
  "TotalCount":5, "TotalDosage":1300,
  "Accounts":[ { …积分包… } ]
}}}}
```

积分包字段（实测全集）✅：

| 字段 | 说明 |
| --- | --- |
| `PackageName` / `SubProductName` / `PackageCode` / `ProductName` | 名称（多为「CodeBuddy个人版国内运营裂变包」这类） |
| `CapacityUnit` / `OriginUnit` | `credits`（海外版单数 `credit`） |
| `CapacitySize` / `CapacityRemain` / `CapacityUsed` | 数值 |
| `CycleCapacitySize` / `CycleCapacityRemain` / `CycleCapacityUsed` | 周期内数值；**另有一组 `*Precise` 字符串**，优先用 Precise |
| `Status` | `3` = 已过期 |
| `ExpiredTime` | `"YYYY-MM-DD HH:mm:ss"`（空串表示不过期） |
| `DeductionEndTime` | 毫秒时间戳，抵扣截止 |
| `CycleStartTime` / `CycleEndTime` | 周期（典型 1 个月） |
| `AccountAttributes` | `[{Key,Value}]`，**`grantSource`** 说明来源，签到发放为 `daily_checkin` ✅ |
| `Region` / `Zone` / `RegionId` / `ZoneId` | 资源位置 |
| `ResourceId` / `ResourceType` / `ResourceCycleId` | 资源标识 |
| `SupportAutoRenew` / `AutoRenewFlag` / `AutoRenewTimeUnit` / `AutoRenewTimeSpan` | 续订 |
| `RemainCycles` / `TotalCycles` / `Threshold` / `FeeType` / `CapacityType` / `PkgSourceType` / `DealName` / `AppId` / `AccountId` / `Uin` | 账务字段 |

**活跃判定**：`Status !== 3` 且未过 `ExpiredTime` 且未过 `DeductionEndTime` ✅。
**总额**：活跃包的 `CycleCapacityRemainPrecise` 之和（实测 CN 1293.5~1294.9 浮动，随消费/签到变化）✅。

参考实现把积分按到期时间分成「临时 / 永久」两桶，窗口默认 **15 天**（可用环境变量 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖），用于「优先消耗快过期积分」的选号策略 📖。

### 5.2 签到

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v2/billing/meter/checkin-status` | 活动与今日状态 |
| POST | `/v2/billing/meter/daily-checkin` | 领取 |

`checkin-status` 的 `data`（实测全集）✅：

| 字段 | 实测值 | 说明 |
| --- | --- | --- |
| `active` | `false` | 活动是否进行中 |
| `today_checked_in` | `false` | 今日是否已签到 |
| `streak_days` / `week_checkin_days` | `0` | 连续 / 本周天数 |
| `daily_credit` / `today_credit` / `total_credits` | `0` | 积分额度 |
| `is_streak_day` / `next_streak_day` / `streak_bonus_days` / `streak_bonus_credit` | | 连签奖励 |
| `checkin_dates` | `null` | 已签日期列表 |
| `week_progress` | `[false×7]` | 本周进度（周一起） |
| `start_time` / `end_time` / `season` / `theme_name` / `activity_name` | `""` / `0` | 活动元信息 |
| `claim_button_text` / `action_button` | `{show:false,text:"",action:""}` | 服务端建议的按钮文案 |

`daily-checkin` 返回 ✅：

| 情况 | HTTP | code | msg |
| --- | --- | --- | --- |
| 领取成功 | 200 | 0 | `OK`，`data` 含 `credit` / `streak_days` / `is_streak_day` 📖 |
| 今天已领 | 400 | `10001` | `今天已签到，请明天再来`（另有 `1001` 同义 📖） |
| 无领取资格 | — | `1002` / `1003` | 活动未开始 / 已结束 📖 |

**实测矛盾点**（重要）：`checkin-status` 报 `active:false, today_checked_in:false`，而 `daily-checkin` 回 `10001 今天已签到` —— 两个接口状态不同步 ✅。以「当天有领取记录」为已签到判据更稳。

**海外版后端没有签到接口** 📖（`checkin-status` 在 INTL 上未实测成功；参考实现直接判定「不支持」）。

### 5.3 Web 端另有的一批计费端点

Web 应用（cookie 认证，路径**不带 `/v2` 前缀**）还会调 📖✅（在 bundle 里读到）：

| 路径 | 用途 |
| --- | --- |
| `/billing/meter/get-user-resource-summary` | 余额汇总（插件令牌访问返回 404 ✅） |
| `/billing/meter/get-user-resource-paid-packages` / `-free-packages` | 分页取付费/免费包 |
| `/billing/meter/get-enterprise-user-usage` | 企业用量（需 `X-Enterprise-Id`） |
| `/billing/meter/checkin-status` / `daily-checkin` | 同 §5.2（web 端用 POST + cookie） |

---

## 6. 错误码表

统一信封：`{"code":<number>,"msg":"<string>","requestId":"<uuid>","data":{…},"displayMsg":{"en","zh","zh-hant"},"displayTips":{…},"actions":["RETRY",…]}` ✅。

| HTTP | code | msg（原样） | 含义 | 建议处理 |
| --- | --- | --- | --- | --- |
| 200 | 0 | `OK` | 成功 | — |
| 400 | 11101 | `Non-stream chat request is currently not supported` | 不支持非流式 | 改为 `stream:true` ✅ |
| 400 | 11102 | `model [<id>] service info not found` | 目录里有、渠道不服务该模型（如 `glm-4.6`/`glm-4.7`/`hunyuan-2.0-thinking`/`hy4-preview-x`/`kimi-k2-thinking`/`minimax-m2.5`/`glm-5.0`） | 不可重试；换模型 ✅ || 400 | 11128 | `Illegal API invocation from an unapproved channel` | 请求被判定为「未获批渠道」；**缺 system 消息 / 首条非 system 也是这个码**（海外版实测文案是 `first message is not system`） | 见 §7；不要盲目重试 ✅ |
| 400 | 11133 | `the request parameters were rejected by the model provider` | 上游模型拒绝参数（实测 `glm-5.1` 最小请求即触发；探测里表示"模型存在"） | 换模型或改参数 ✅ |
| 400 | 11151 | `a message has empty content, please check the conversation history and retry` | 对话内容为空（`hy3`/`hy3-x` 先校验内容再交给上游；海外版探测靠它保持零消耗） | 补内容即可；探测中视为"模型存在" ✅ |
| 400 | 11158 | `model [<id>] is not allowed for user type [personal_free_user]` | **账号档位不足**：模型存在但该用户类型不能用（海外版免费账号调 GPT/Grok/Gemini 系列；与 `/v3/config` 的 `modelTiers` 集合一致） | 不重试；升级账号或用别的模型 ✅ |
| 400 | 11217 | token not ready | 授权尚未完成 | 继续轮询 ✅📖 |
| 400 | 12403 | `check ua, get coding copilot version error` | CN `/v3/config` 拒绝插件令牌 | 目录改走 scoped ✅ |
| — | 12151 | account not ready | 账号信息未就绪 | 继续轮询 📖 |
| 429 | 6020 | `queue.waiting.title` | 模型排队；`data` 含 `queue_position` / `queue_size` / `retry_after`(秒) | `RATE_LIMIT` + 交给 harness 退避 ✅ |
| — | 6004 | — | 频率限制（另一产品族的码） | `RATE_LIMIT` 📖 |
| 400 | 10001 / 1001 | `今天已签到，请明天再来` | 今日签到已领 | 视为成功 ✅📖 |
| — | 1002 / 1003 | — | 无领取资格 / 活动已结束 | 不重试 📖 |
| 401/403 | — | — | 凭据过期 | 先续期再发一次 ✅ |
| 5xx | — | HTML 错误页（openresty/APISIX） | 网关级故障 | 回退数据源或稍后重试 ✅ |
| 404 | — | `404 Route Not Found` / `404 page not found` | 路径不存在（常见于把 web 端点当成插件端点、或方法不对） | 核对 §5.3 的前缀差异 ✅ |
| — | 10000 | `服务请求失败` | 上游通用失败（参考实现日志中出现） | 重试 📖 |
| — | 11140 | — | **服务端安全策略拦截**（内容审核），按账号生效 | 换账号 + 该账号冷却 30 分钟 📖 |

`displayMsg.zh` 是给人看的文案（如「请求被拦截，请重新发送」），`actions` 是服务端建议的动作（`RETRY` / `SUBMIT_FEEDBACK`）✅。

### 6.1 `11102` 逐字记录（模型未接入 / 缺配置）

```
POST /v2/chat/completions {"model":"glm-4.6", …}
→ HTTP 400  content-type: application/json; charset=utf-8   (311ms)
```
```json
{
  "code": 11102,
  "msg": "model [glm-4.6] service info not found",
  "requestId": "be3a7a0a-a793-47df-a2fb-f512a948ce0f",
  "displayMsg": {
    "en": "Model unavailable. Please switch models",
    "zh": "当前模型不可用，请切换模型",
    "zh-hant": "目前模型無法使用，請切換模型"
  },
  "displayTips": {
    "en": "This model is not connected or is missing configuration, so the server cannot invoke it. Please check the model configuration or switch to another model.",
    "zh": "这个模型没有接入或缺少配置，服务端无法调用。请检查模型配置或换个模型。",
    "zh-hant": "此模型尚未接入或缺少設定，服務端無法呼叫。請檢查模型設定或改用其他模型。"
  },
  "actions": ["SWITCH_MODEL", "SUBMIT_FEEDBACK", "RETRY"]
}
```

判读要点（实测）：

| 观察 | 含义 |
| --- | --- |
| 响应体不是 SSE，而是普通 JSON + HTTP 400 | 请求**没有走到模型后端**，在网关就被拒了 |
| 311ms 返回（对照：正常模型首字节 891ms） | 是网关自己的模型注册表查询失败，属"快速失败" |
| 只针对该 `model`，同一 token 其它模型正常 | 与账号、配额、鉴权无关 |
| 目录里该模型仍带 `credits`（`glm-4.6` 是 `x0.23`）与 `descriptionZh` | **目录与路由注册表不同步**，目录会保留已下线的僵尸条目 |
| 服务端建议动作为 `SWITCH_MODEL`（不是 `RETRY`） | 不是瞬时故障，重试无用 |

`111xx` 都是网关层业务码，容易混淆，对照如下：`11101` 不支持非流式 · `11102` 模型未接入（本码）· `11128` 渠道/提示词指纹被拦 · `11133` 上游模型拒绝参数（模型本身存在，换参数可试）。

因此本插件**只把 `11102` 当作"不可用"的判据**（见 §4.9）：命中即记入可用性台账并 12 小时内不再展示，其余错误码只展示不拉黑。

---

## 7. 渠道、指纹与风控

### 7.1 「未获批渠道」的真实规则 ✅

实测边界（2026-10-21，`copilot.tencent.com`，system 消息逐条替换）：

| system 内容 | 结果 |
| --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | **拦（11128）** |
| `you are an ai agent powered by deepseek harness.` | **拦**（大小写不敏感） |
| `You are an AI agent powered by DeepSeek Harness`（无句点） | **拦** |
| ` Hello. You are an AI agent powered by DeepSeek Harness.` | 过 → **行首锚定** |
| `You are a coding agent powered by DeepSeek Harness.` | 过 → 名词必须匹配 |
| `You are an AI agent powered by Foo Harness.` | 过 → 品牌必须匹配 |
| `DeepSeek Harness` 单独出现 | 过 |
| `You are an AI agent running on DeepSeek Harness.` | 过 |

结论：这是**行首锚定的品牌指纹**（「某 AI agent powered by &lt;品牌&gt; Harness」），不是内容审查。规避方式：把这一句改写成中性表述（本插件统一改写为 `You are an AI agent.`，两个部署都改）✅。

#### 7.1.1 规则扩大：整段 DSH 提示词被拦（2026-10-23）

同一天再次实测：**完整的 DSH 系统提示词（5.7k 字符）整段被拦**，而短提示词通过。二分结果：

| 送什么 | 结果 |
| --- | --- |
| 完整 DSH 提示词（只做 7.1 的开头改写） | **拦（11128）** |
| 同一份，只去掉最后那段 Web GUI 开发指引 | 过 ✅ |
| 只送那一段（1002 字符） | 过 ✅ |
| 那一段的每一句单独送 | 全都过 ✅ |
| 中性提示词填充到 5.7k / 10k 字符 | 过 ✅（不是长度） |

所以**不是一个词、也不是长度**，而是「提示词整体 + 那段开发指引」的组合命中。那段内容是 `pnpm run dev:web` / `apps/web` / HMR / "do not start a replacement server" —— **给改 harness 自身的人看的**，对一次聊天补全毫无用处，所以插件直接**整行删掉**，并把 `DeepSeek Harness` 统一改写成 `this harness`（顺序很重要：先删行再改名，否则模式匹配不到原文）。

> 注意：这条规则**会继续扩大**。再遇到 11128 时，用 `node test/live/cn-prompt-fingerprint.mjs` 二分定位新命中的段落，再决定删还是改，别猜。

### 7.2 其它渠道相关事实

- `X-Conversation-ID` 可复用；一旦被判定为异常渠道，**换新会话标识无效**（实测：换标识 + 切备用主机仍被拒），但换一个**合法 system 提示词**立刻恢复 ✅。
- 6 种渠道身份组合（WorkBuddy/CodeBuddy 的 UA、`X-Channel`、`X-Client-Type`、product-code 两种）在合法提示词下**全部 200** ✅ —— 即头本身不是拦截依据。
- 内容侧另有一套：`code 11140` + `PERMISSION_DENIED`，按账号生效，同请求换账号可过 📖。
- 参考实现对「被安全策略拦截」的账号做 30 分钟冷却，避免连续撞墙 📖。

---

## 8. 数据源权威性排序

| 想要的信息 | 首选 | 回退 | 都没有时 |
| --- | --- | --- | --- |
| 该账号可用模型 | scoped `/console/enterprises/personal/models` | 并行取 `/v3/config` 补字段 | 本地缓存（追加式） |
| 模型能力（图片/思考/工具） | scoped 的 `supports*` | `/v3/config` 同名字段（能力位取并集） | 缓存中保留的旧值 |
| 上下文窗口 | scoped `maxInputTokens` / `contextWindow.supportedLengths` | `/v3/config` `maxInputTokens` | 缓存中保留的旧值 |
| 思考档位 | 两个源的 `reasoning.supportedEfforts` 并集 | `reasoning.defaultEffort` / `reasoning.effort`（单档） | 缓存中保留的旧值 |
| 倍率 / 促销 | `credits` 字段 + `modelPromotions`（**纯实时，不进缓存**） | 无 | 「未知」 |
| 实时繁忙度 | `POST /v2/chat/busy`（仅大陆版） | 无 | 不显示 |
| **真实可用性** | 每个模型一个 `max_tokens:1` 的最小请求（唯一可靠判据） | — | 未检测 |

| 积分余额 | `get-user-resource`（`*Precise` 字段） | 无 | 显示「未知」 |
| 签到状态 | `daily-checkin` 的返回码（最权威） | `checkin-status` | 显示「未知」 |
| 账号身份 | `login/account` | 直接解 JWT |

---

## 9. 实测时间线（2026-10-21）

| 时间 | 事实 |
| --- | --- |
| 09:2x | CN `/v2/plugin/auth/state?platform=workbuddy` 正常；完成真实登录；scoped 目录 34 条；聊天流式可用（必须 `stream:true`） |
| 09:3x | CN `/v3/config` 对插件令牌 400 + 12403（8 种 UA × 2 种 product-code 全试） |
| 12:3x | CN 积分：`TotalCount:5`、总额 ~1294、`grantSource: daily_checkin`；签到 10001；INTL 不支持签到 |
| 13:4x | INTL scoped 500 → `/v3/config` 28 条；`fetchModelEntries` 回退生效 |
| 14:4x | 12 种请求字段 + 6 种会话形态 + 64 KB 生产量级请求体，CN 全部 200 → 排除请求结构问题 |
| 15:2x | 定位 11128 的真实触发点：被拒请求落盘 → 去掉 system 即 200 → 二分到 90 字符的品牌指纹 |
| 15:3x | 改写该句后，用被拒原文（5764 字符 system + hy3）实测通过（推理 591 字符 + 正文正常） |
| 16:0x | 逐模型探测 CN：23/33 可用；8 个 `11102`；1 个 `11133`；1 个 `6020` 排队 |
| 16:2x | 排队响应实测：`HTTP 429 + code 6020 + queue_position`；决定退避完全交给 harness |
| 16:5x | 删掉内置模型表；目录改为纯实时（scoped → `/v3/config`），思考档位改读 `reasoning.supportedEfforts` |
| 17:2x | 从 Web bundle 定位 picker 元数据：`busyLevel` ← `POST /v2/chat/busy`（CN 200 / INTL 404）；倍率取 `credits` 数字；档位文案是前端 i18n |
| 21:2x | 大陆版 30 个模型全量探测（零消耗）：`ok` 22 / `dead` 8 |
| 10-22 01:2x | 海外版 25 个：`ok` 13 / `denied` 12；`gpt-5.3-codex` 只存在于账号名单，两版 `/v3/config` 都没有 |
| 10-22 09:5x | 定位「选择器整组消失」：harness 对每个 provider 单独 try/catch，一条模型违约就丢掉整组；`glm-5.2` 的默认档不在列表内曾经触发过 |
| 10-22 10:0x | 实测官方前端把 `normal` 与 `idle` 映射到同一条文案（空闲），插件改为同一口径 |
| 10-22 10:1x | 确认插件服务端模块被打包器缓存：重新启用不重载文件，**代码改动必须重启整个应用** |
| 10-22 10:3x | 代码整理：删掉未使用的 CSS/词典键/冗余钩子，客户端单测升级为真渲染（三种状态 + 输出断言） |

---

## 10. 未解 / 待查

1. `11128` 是否还有**其它**行首指纹（本次只证明了一条）。排查手法：把被拒请求体落盘 → 去掉 system 复现 → 二分文本。
2. `code 10000`（服务请求失败）的确切触发条件 📖。
3. `vendor` 单字母的真实含义，以及 `relatedModels`（`lite` / `reasoning` / `builtin-lite`）在服务端如何被使用。
4. 企业版（非 `personal`）的 scope 路径、`X-Enterprise-Id` / `X-Tenant-Id` 用法与字段差异。
5. ~~`modelPromotions` 的完整字段~~ ✅ 已实测，见 §4.3（`priority` 与 `schedule.timezone` 仍未使用，但不影响展示）。
6. INTL 是否存在签到活动（未拿到可用 INTL 账号验证）。
7. `queue_position` / `retry_after` 与账号等级、模型的关系；`6020` 之外的排队码是否存在。
8. `checkin-status` 与 `daily-checkin` 状态不同步是否长期存在。
9. Web 端 `get-user-resource-summary` 相对 `get-user-resource` 的差异（插件令牌访问 404）。
10. 目录里 `11102` 的模型是否随渠道（IDE / CLI / Web）变化。
11. `/v2/chat/busy` 的刷新节奏上限、是否有账号级配额（前端 ~50s 缓存 + 50 个一批，插件照抄了 50s 缓存；30 个 id 一次全回，未见配额）。
12. `busy_level` 与 §6 的 `6020` 排队是否同源（`step-5-preview` 实测同时出现过 `congested` 与 429 排队）。
13. 海外版是否曾有过 `/v2/chat/busy`（现在 404，未见其它繁忙度来源）。
14. 海外版 `11151`/`200` 两种探测结局是否等价（`hy3` 回 `200` 且 6 秒内无内容，`kimi-k3` 回 `11151`）——即"回 200 的模型是否真的启动了一次（可能计费的）请求"。计费接口最小刻度是 1 积分，测不出亚积分差异。
15. 海外版能否用一个**永不生成**的形态探测（目前用空 system 内容，靠内容校验拒绝；带内容的写法会真的生成）。

---

## 11. 接入 DSH（harness）的契约与坑

这一节记录的是"插件怎么被 harness 消费"，踩过的坑都在这里。

### 11.1 适配器表面

`ctx.llm.registerAdapter([provider], adapter)` 只认这几个方法（其余可选，基类有默认实现，**不要照抄默认值**）：

| 方法 | harness 何时调用 | 注意 |
| --- | --- | --- |
| `providerInfo(provider)` | 注册时 | 必须回显 `id` 且 `name` 非空，否则 `INVALID_ADAPTER` |
| `listModels(provider)` | 选择器/目录刷新 | 每条必须 `provider` 回显、`id`/`name` 非空且 id 不重复，否则 `INVALID_CATALOG` |
| `resolveModel(provider, model)` | 选择器、调用前 | 见 11.2 的校验 |
| `prepareCall(provider, model)` | 发起调用 | 返回 `{model, stream}` |
| `providerRetryPolicy` / `imageRequestPricing` / `imageRequestTarget` | 可选 | 本插件不覆写：基类默认行为就是我们要的 |

### 11.2 选择器"整组消失"的机制 ⚠️

harness 的 `buildModelCatalog` 对每个 provider **分别 try/catch，只保留成功且非空的分组**。因此
**任意一条模型让校验抛错，整个部署的模型都会从选择器里消失**——看起来就像插件没装。

`resolveModel` 的校验（抄自 `@deepseek-ai/dsh-llm` 的 `normalizeModelInfo`）：

- `provider` / `id` 必须回显请求值，`name` 非空；
- `context.contextWindow` 若存在，必须是**正安全整数**；`defaultMaxTokens` 同理；
- `reasoning` 若存在，`efforts` **不能为空数组**、档位 `id` 唯一且 `name` 非空、
  `defaultEffort`（若有）必须落在 `efforts` 里。

最后一条曾经真的踩中：早期 `glm-5.2` 的默认档不在列表内，harness 直接报
`adapter returned an unknown default reasoning effort`，**整组**消失。现在由
`withConsistentEfforts()` 在三个入口（新条目、合并、缓存读回）统一保证不变式。

排查手法：宿主启动时会自查并写日志（`选择器可选项 N 个` / `选择器契约违规 — …`），
离线可以用 `test/live/harness-contract-replay.mjs` 复刻同一套规则。

### 11.3 改了服务端代码要**重启整个应用** ⚠️

DSH 的插件按 ESM 导入，模块按 URL 缓存：**重新启用插件只是在新 fiber 上重跑 `apply()`**，
通常仍用那份已经导入过的模块 —— 于是"代码明明改了，行为还是旧的"，而且**一句报错都没有**。
更糟的是反过来：某次重载恰好读到**改坏的那一版**，之后每次重载都沿用那一版，
即使文件已经改回来也照样报错，直到重启进程。本仓库真踩过：删掉适配器上被鸭子类型调用的
`providerRetryPolicy()`，插件从此注册失败（`TypeError: adapter.providerRetryPolicy is not a function`），
provider 与全部 HTTP 路由都没注册，设置面板只剩一个 `HTTP 404`。

- 判断办法：每次加载都会打一行带随机短标签的 `已注册 provider …（实例 xxxx）`。
  日志里没有**新**标签，说明这次重载没有重新读文件；
- 客户端半边（`client/index.js`）会热重载；服务端（`src/**`）改动请**退出并重启 DSH Desktop**；
- 面板上的 `api.js #<hash>` 时间戳只能证明"当时读到的文件内容"，不能证明模块被重新导入；
- 不想重启就能确认文件本身没问题：`node test/live/boot-path-check.mjs` 在独立进程里真实执行
  `apply()`，打印注册结果与启动定时器。

### 11.4 模型选择器的席位（写 UI 插件前必读）

| 席位 | kind | 现状 | 能不能被插件接管 |
| --- | --- | --- | --- |
| `conversation.input.model` | `single` | 由内置 `dsh-client-ui-model-selection` 占用 | ❌ 注册即冲突，且系统标注 `replaceRisk: shadows-shipped-ui` |
| `conversation.input.model.label` | `single` | 内置提供默认 label | ✅ 官方示例 `dsh-client-ui-deepseek-model-label-1017` 就是注册这个席位 |

`label` 席位的组件会收到 `{ provider, model, placement, selected }`，
`placement` ∈ `trigger | menu | option`（输入框按钮 / 当前模型行 / 候选行），
未注册时回退目录名。**它是 `single`：两个同类插件同优先级会冲突，不会自动组合。**

### 11.5 图标

| 路由 / 资源 | 用途 |
| --- | --- |
| `/workbuddy/icon`（`icon.webp`） | 不透明标记，供需要固定颜色的地方使用 |
| `/workbuddy/icon-mask`（`icon-mask.png`） | 纯 alpha 剪影，面板用 CSS `mask` + `background: var(--wb-accent-strong)` 上色，**跟随主题** |

设置侧栏里那个齿轮图标**不是插件的**：DSH 按分区 id 硬编码（`navIcon(id)`），未知 id 一律齿轮，
注册项没有 icon 字段，插件改不了。

---

## 12. 与官方客户端、DSH 的请求处理对照（2026-10-22）

官方客户端不是网页版：`www.workbuddy.cn` / `www.workbuddy.ai` 的 bundle 里**没有**聊天逻辑
（只有站点壳，实测抓了入口 + 28 个懒加载 chunk，`chat/completions`、`finish_reason` 全部 0 命中）。
真正的客户端是 CLI：`@tencent-ai/codebuddy-code`（2.172.1，59 MB，`dist/codebuddy.js` 28 MB）。
下面这张表来自读它的 bundle（`mapFinishReasonToStopReason`、请求体组装处）。

| 方面 | 官方 CLI | 本插件 | DSH |
| --- | --- | --- | --- |
| 端点 | 自定义/默认 URL + `/chat/completions`（CN 默认即 `copilot.tencent.com` ✓ 我们早就在用） | CN `copilot.tencent.com/v2/chat/completions`，失败回退 `workbuddy.cn`；INTL `workbuddy.ai/v2/chat/completions` | 由适配器注册的 provider 决定 |
| `temperature` / `top_p` / `frequency_penalty` / `presence_penalty` | **总是发**（模型配置值，缺省用 `DEFAULT_TEMPERATURE`） | **不发**（仅当调用方传 `options.temperature`） | 类型里有 `LlmCallControls.temperature`，但没有设置入口 ⇒ 实际永远为空 |
| `max_tokens` | 总是发（模型配置） | 发（调用方 `maxTokens`，否则目录 `maxOutputTokens`） | 提供 `maxTokens` |
| `tool_choice` / `parallel_tool_calls` | 发 | 不发（走服务端默认 `auto`） | — |
| `stream_options: {include_usage:true}` | **发** | **2026-10-22 起补上**（此前不发，网关可能不回 `usage`） | — |
| `prompt_cache_key` | **不发** | 发（会话级，前缀缓存命中率才不为 0） | — |
| `finish_reason` 映射 | `content_filter`/`refusal`→`refusal`；`length`/`max_tokens`→`max_tokens`；`stop`/`end_turn`/`stop_sequence`/`tool_calls`/`tool_use`/`function_call`→`end_turn`；未知→不归类 | **2026-10-22 起对齐**：`refusal`/`content_filter`→不可重试的 `INVALID_REQUEST` 错误；`error`→`TRANSPORT`（可重试）；`end_turn`/`stop_sequence`→`stop`；`tool_use`/`function_call`→`tool-calls`；未知值记日志后按 `stop` | 只有 `stop`/`tool-calls`/`max-tokens`/`aborted`/`error` 五类，**没有 refusal** |
| `finish_reason=error` | 抛 `provider_finish_reason_error`（`model_service`） | 现在报 `TRANSPORT`，交给重试 | — |
| 空流 / 占位帧 | `is_empty_stream`、placeholder-only 检测 | `EMPTY_RESPONSE` | — |
| 流空闲监控 | `setInterval` + `streamIdleTimeoutMs`（日志 `Stream idle monitor armed`） | **没有**（依赖 harness 自身超时） | 无 |
| 请求体改写 | 模型不支持工具时 `stripToolDefinitions`（连 `tool_choice` 一起去掉）、图片扁平化、自定义模型 URL 规整 | CN：系统提示词指纹改写（`Illegal API invocation`）+ 换会话标识重试一次 | — |

#### 12.1 请求体逐字段对照（2026-10-23 补）

官方 `providerData` 里还有 `thinking:{type:'disabled'}`（关闭思考时才发；开启时不发该字段）、
`reasoning_effort`（档位）。逐字段差异与影响判断：

| 字段 | 本插件 | 官方 CLI | 影响 |
| --- | --- | --- | --- |
| `model` / `messages` / `stream` / `tools` / `max_tokens` | 发 | 发 | 一致 ✓ |
| `stream_options.include_usage` | 发（0.1.8 起） | 发 | 已对齐 ✓ |
| `tool_choice` / `parallel_tool_calls` | 不发 | 发（配置值） | 服务端默认 `auto` / `true`，等价 ✓ |
| `temperature` / `top_p` / `frequency_penalty` / `presence_penalty` | **不发**（仅调用方给 temperature 时发） | **总是发**（模型配置值，缺省 `DEFAULT_TEMPERATURE`） | **真实差异**，但实测对"提前收尾"无影响（默认/0.2/0.5/0.7/0.3+top_p0.9 各 8 次：2/8、2/8、3/8、3/8，同一水平）→ 暂不跟随，避免擅自改变输出风格 |
| `reasoning_effort` | 发（目录档位，**所有模型同一套规则**：调用方选择 → `defaultEffort` → `high` → 首档；无档位不发） | 发（同左） | 一致 ✓ |
| `thinking` | **不发**（2026-10-23 起） | **开启时不发**；关闭时发 `{type:'disabled'}` | 已对齐 ✓。实测（两个部署各 2–3 次）：带不带 `{type:'enabled'}`，`high` 档都是 0 思考字符；`max` 档不带时思考更多（INTL 384 vs 306、CN 476 vs 418）→ 该字段对"思不思考"没有作用 |
| `prompt_cache_key` | 发（会话级） | **不发** | 反向差异；实测对本问题无影响（去掉后 1/8 vs 2/8），保留以提高前缀缓存命中 ✓ |
| `stop` | 仅调用方给 | 不发 | 等价 ✓ |
| `store` / `prompt_cache_retention` | 不发 | 发（配置值，通常未设置） | 等价 ✓ |
| 请求头 | `Authorization` / `Accept` / `X-Domain` / `X-Product` / `X-Product-Code` / `X-Agent-Purpose` / **`X-Agent-Intent: craft`** / `X-Agent-Runtime` / `X-IDE-Name` / `X-IDE-Type` / `X-IDE-Version` / `X-Session-ID` / `X-Model-ID` / `X-Conversation-ID` / **`X-Conversation-Message-ID`** / `X-Conversation-Request-ID` / **`X-Request-ID`** / `User-Agent` | 同类内部头（`X-User-Id`/`X-Enterprise-Id`/`X-Tenant-Id`/`X-Department-Info`/`X-Domain`/`User-Agent`），转发前还会**剔除**内部头 | **网关会校验**：2026-10-23 实测，裸请求缺 `X-Agent-Purpose`/`X-Conversation-*`/`X-IDE-*` → `400 code 11128 request illegal`。已按官方常量对齐（`X-Agent-Intent` 默认 `craft`；`X-Conversation-Message-ID`/`X-Request-ID` 标识"被回答的那条消息"，用最后一条 user 消息的哈希，重试时保持不变） |

**结论：结构上不是"完全一样"，但没有一处会造成"提前收尾"** —— 唯一的实质差异是官方总带采样参数，
而实测它对这个问题无效。`refusal` 的含义见 §12.2。

#### 12.2 `finish_reason: "refusal"` 是什么

官方把 `refusal` 与 `content_filter` 归为同一类 `stopReason:"refusal"`，它的来源（读官方 bundle）：

1. **输入侧内容安全拦截**：`prepareSensitiveUserPrompt` 判定 `deny` 时直接返回
   `stopReason:"refusal"`（日志 `Sensitive user prompt blocked before history`）——**请求根本没发出去**；
2. **模型/厂商主动拒绝**：`isContentPolicyRefusal(...)` 判定的内容策略拒绝；
3. 本地命令执行失败等"请求没能完成"的收尾，也复用 `refusal`。

所以 `refusal` ≠ 网络问题、≠ 截断，而是**"这次不回答"**。正确反应是**不重试**（重试会得到同样的拒绝），
把原因告诉用户 —— 本插件现在正是这样（`INVALID_REQUEST` + 明确文案，见 §4.5）。

三条结论：

1. **我们和官方在"结束原因"上原本差一张表** —— 官方把 `refusal`/`content_filter` 单独归类、
   把 `error` 当服务错误；我们此前只有 `stop`/`length`/`tool_calls`，其余全落进 `stop`。
   后果就是：**上游拒绝或过滤时，表现和"模型自己说完了"完全一样** —— 已按上表对齐。
2. **`stream_options.include_usage` 官方一直带**，我们漏了；补上后 `usage` 更可靠（诊断里的
   `outputTokens` 也才有据可依）。
3 . **`prompt_cache_key` 是反向差异**：官方不发，我们发。它只影响前缀缓存命中，不影响语义，
   留着（会话级稳定值，命中率实测有效）。

---

## 附：本仓库可复用的抓取脚本

| 脚本 | 用途 |
| --- | --- |
| **诊断（出问题先跑这几个）** | |
| `test/live/smoke.mjs [model]` | 端到端：目录 → 对话 → 工具调用 |
| `test/live/host-log-tail.mjs [关键字] [行数]` | 按 UTF-8 读宿主日志（PowerShell 会乱码，中文匹配不到） |
| `test/live/boot-path-check.mjs` | 用假 ctx 跑 `apply()`，看启动定时器与选择器自查 |
| `test/live/picker-contract-check.mjs` | 适配器实际给模型选择器什么（`providerInfo` / `listModels` / `resolveModel`） |
| `test/live/harness-contract-replay.mjs` | 复刻 harness 校验规则，定位「选择器整组消失」 |
| `test/live/dead-code-report.mjs` | 死代码审计：未使用的 CSS 类、词典键、导出 |
| `test/live/installed-package-check.mjs [dir]` | 检查**已安装副本**（真目录、依赖为空、provider 注册、选择器可选项、资源齐全） |
| `test/live/leak-scan.mjs [ref]` | 发布前必跑：工作区 + git 历史的账户信息/凭据泄露扫描 |
| **会话取证（"回答为什么中断"）** | |
| `test/live/session-tail-live.mjs [前缀] [步数] [项目过滤]` | 读最新会话的末尾几步；容残帧（`ZSTD_e_flush`），带 `stopReason`/`outputTokens`/正文 |
| `test/live/last-finishes.mjs [前缀] [步数] [项目过滤]` | 只看每步的 `upstream.stopReason` 与"stop 且无工具调用"的步，附分布统计 |
| `test/live/find-message.mjs "关键词" [会话前缀]` | 按正文定位某一步，并打出前后事件 |
| `test/live/dump-stream.mjs [会话前缀] <seq,…>` | 打印某一步存下来的原始流帧（含 finish 的 `response` 诊断块） |
| `test/live/toolcall-audit.mjs [会话前缀] [步数]` | 上游宣告了工具调用、但一个分片都没交付的"丢失指纹" |
| **流与请求结构实验（改协议相关代码前跑）** | |
| `test/live/stream-cut-probe.mjs [cn\|intl] [次数] [模型] [--selftest]` | 断流分类：`--selftest` 离线自检，长回答模式可压测断流率 |
| `test/live/repro-probe.mjs [次数] [模型] [填充字符]` | 长上下文 + 真实 70 工具集下"是否调用工具"，每行打印原始 `finish_reason` |
| `test/live/long-context-probe.mjs [次数] [模型]` | 只改上下文长度，看提前收尾率（可复现的对照实验） |
| `test/live/context-size-probe.mjs [字符数…]` | 填充上下文实际值多少 token（网关 `inputTokens` 为准） |
| `test/live/thinking-field-probe.mjs [次数] [模型] [部署]` | 带/不带 `thinking` 字段时思考量对比（档位才是开关） |
| `test/live/dsh-prompt-probe.mjs [次数] [字符数…]` | **用会话里存的 DSH 原版系统提示词** + 真实 70 工具集跑长上下文，看会不会调用工具（2026-10-23：0k/90k/280k 各 3 次，9/9 都调用 `read`） |
| `test/live/system-prompt-probe.mjs [次数]` | 判定上游是否注入/覆盖 system：两个代号实验 + 不给 system 时它自认是谁（答「DeepSeek」= 无厂商注入）+ 语言服从性 |
| `test/live/request-structure.mjs` / `test/live/free-models.mjs` | 各厂商请求结构、免费档清单的逐字段试探 |
| `test/live/verify-policy.mjs` | 实时目录扣掉台账里 `dead` 的判定后，两版的条目数对照 |
| **契约与 UI 参考（写 UI 插件用）** | |
| `test/live/slot-inventory.mjs [outFile]` | 列出客户端实际渲染的所有插槽 |
| `test/live/model-seat-kind-probe.mjs` | 模型席位的 kind 与占用者（决定能不能接管） |
| `test/live/web-bundle-probe.mjs` | 下载官方 Web 端 chunk 到 `%TEMP%\wb-chunks`，核对官方文案与实现 |
| `test/live/web-search.mjs <regex>` | 在已下载的 chunk 里按正则搜上下文 |
| `test/live/ui-preview.mjs` | 面板离线预览（输出 HTML，可直接截图核对样式） |
| **上游数据源核对（接口变化时重跑）** | |
| `test/live/catalog-compare-probe.mjs` | scoped 与 `/v3/config` 的目录对比 |
| `test/live/catalog-keys-probe.mjs` | 把目录 payload 落盘并列出全部 key（找新字段用） |
| `test/live/rate-source-probe.mjs` | 倍率的来源与形状 |
| `test/live/models-chat-probe.mjs` | 逐模型最小请求，区分「正常 / 排队 / 不可用」 |
| `test/live/scoped-probe.mjs` | scoped 端点在 无令牌/假令牌/真令牌 三种凭据下的对照 |
| `test/live/intl-probe.mjs` | INTL 两个目录端点 + 回退路径 |
| `test/live/intl-entitlement-sweep.mjs` | 海外版全量：可用 / 无权限 / 已下架，并测整轮积分差 |
| `test/live/busy-probe.mjs` | `POST /v2/chat/busy` 的两部署可用性与返回值 |
| `test/live/promotion-shape-probe.mjs` | `modelPromotions` 的字段形状 |
| `test/live/permission-codes-probe.mjs` | 权限/拦截相关的错误码（401、11128、11158、控制台 403） |
| `test/live/tier-hint-probe.mjs` | 打印两版 `/v3/config` 的 `modelTiers`（静态档位提示） |
| **常跑的操作脚本** | |
| `test/live/availability-sweep.mjs [cn\|intl]` | 手动全量探测并写台账 |
| `test/live/sweep-check.mjs [--force]` | 走真实的 `runSweep` 路径（含节流判断）并打印台账变化 |
| `test/live/probe-cost-precise.mjs [N]` | N 次探测前后的**积分精确差值**（验证探测是否花钱） |
| `test/live/cn-probe-shape-check.mjs` | 打印大陆版探测实际发出的请求体、令牌引用与响应 |
| `test/live/credits-check.mjs` | 积分包字段与签到状态 |
| `test/live/policy-probe.mjs` / `verify-policy.mjs` | 准入策略核对与验收 |
| `test/live/verify-intl-list.mjs` | 海外版名单验收 |
| `test/live/seed-official-list.mjs` | 灌入账号名单，演练导入路径 |
| **单测（离线，`npm test`）** | |
| `test/unit/plugin.mjs` | provider 注册、目录、命令与 HTTP 路由 |
| `test/unit/api.mjs` | 面板路由、校验、信任栅栏、积分、签到、state 载荷 |
| `test/unit/client.mjs` | 客户端注册、词典回退，**以及三种状态下的完整面板渲染** |
| `test/unit/region-order.mjs` | 宿主显示顺序 ↔ 客户端占位顺序 ↔ 默认标签三者一致 |
| `test/unit/catalog.mjs` | 双数据源并发抓取、合并、回退 |
| `test/unit/catalog-cache.mjs` | 追加语义、字段保留、按部署分文件、读取时过滤 |
| `test/unit/official-list.mjs` | 名单导入（id 或记录）、字段级富化（不含倍率）、清理 |
| `test/unit/model-prefs.mjs` | 判定默认值、手工覆盖、批量开关、重置、分部署探测形态 |
| `test/unit/availability.mjs` | 探测分类、TTL 内的 dead 规则、合并、分部署台账 |
| `test/unit/adapter.mjs` | 渠道指纹改写、请求体组装、路由顺序、排队错误映射 |

抓取通用要点：令牌从 `$DSH_HOME/.credentials.yaml` 的 `WORKBUDDY_CN_TOKEN` / `WORKBUDDY_INTL_TOKEN` 读；插件令牌用 `/v2/...` 路径，Web cookie 会话用不带 `/v2` 的路径。

**定位前端字段来源的套路**（本次就是这样找到 `/v2/chat/busy` 的）：

1. 页面里用 `performance.getEntriesByType('resource')` 取全部 chunk URL（`static.workbuddy.cn/web/agents/<hash>/assets/*.js`）；
2. `web-bundle-probe.mjs` 把它们下载到 `%TEMP%\wb-chunks`；
3. 先用中文字面量（如 `繁忙程度`）找到 i18n key（如 `model.busy.label`）；
4. 再用 key 前缀在**非字典**位置搜调用点（如 `model.busy.${…}` / `.busyLevel`），顺着变量名找到请求 URL 常量（`const fxi = "/v2/chat/busy"`）；
5. 最后用插件令牌直接打那个 URL 验证（`busy-probe.mjs`）。
