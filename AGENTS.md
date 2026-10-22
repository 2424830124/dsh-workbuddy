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
  regions.js        部署定义（端点、探测形态、聊天路由、是否支持繁忙度）
  http.js           传输与信封工具、JWT/日期工具
  auth.js           登录/续期协议、凭据读写、账号状态
  catalog.js        实时目录（scoped + /v3/config 并行合并）+ 准入策略
  catalog-cache.js  目录落盘缓存（追加、缺字段不覆盖、倍率不落盘）
  availability.js   可用性台账（最小请求探测、分类、12 小时有效期）
  model-prefs.js    每个模型的启停（只落盘"手工决定"）
  official-list.js  账号名单导入（id 或记录，字段级富化，不含倍率）
  busy.js           /v2/chat/busy 的繁忙程度（仅大陆版）
  credits.js        积分、签到、启动/午夜自动领取
  adapter.js        llm 适配器（请求组装、SSE、路由回退、提示词改写）
  api.js            面板用的宿主路由 /workbuddy/*
  index.js          apply()：provider 路由、命令、定时器
client/index.js     设置面板（`settings.section` 槽位的客户端半边）
test/unit/          离线单测（`npm test`，10 个）
test/live/          需要真实账号的在线探针与诊断脚本
```

依赖方向单向：`regions/http` ← `auth/catalog` ← `credits/adapter` ← `api/index`。
`client/index.js` **不 import 任何宿主模块**，只通过 `/workbuddy/*` 路由通信。

## 不能违反的不变量

1. **`defaultEffort` 必须在 `efforts` 里**。harness 校验 `resolveModel` 的结果，违反会让
   **整个 provider 的模型在选择器里消失**。三处统一由 `withConsistentEfforts()` 保证
   （新条目、合并、缓存读回）。
2. **适配器是鸭子类型，7 个方法一个都不能少**：`providerInfo`、`providerRetryPolicy`、
   `listModels`、`resolveModel`、`prepareCall`、`imageRequestPricing`、`imageRequestTarget`。
   harness 在**注册时**就会调用前两个，缺一个直接 `TypeError` → `apply()` 失败 →
   provider 与全部 HTTP 路由都不注册，面板只剩 `HTTP 404`。
   `test/unit/plugin.mjs` 的假注册表会调用同样的表面，删方法离线就会红。
3. **倍率与促销不进缓存**。`credits` 是实时值，缓存里不存、读回时丢弃；取不到就显示「未知」，
   **不要用旧值兜底、不要猜**。
4. **准入策略在读取缓存时也要生效**（缓存是追加的，规则会变）。
5. **显示顺序三处一致**：宿主 `REGION_IDS` ↔ 客户端 `PLACEHOLDER_REGIONS` ↔ 初始标签，
   由 `test/unit/region-order.mjs` 钉住。顺序不一致会让标签在加载完成的瞬间翻转。
6. **只有唯一判据能判定"不可用"**：发一个探测请求。目录字段、`/v2/chat/busy` 都不可靠
   （详见协议文档 §4.9）。探测形态两个部署不同，不要互相套用。

## 开发流程

- **改了 `src/**` 必须重启 DSH Desktop。** 重新启用插件只会在缓存住的模块上重跑 `apply()`，
  改动不一定生效——曾经因此让插件注册失败、面板全面 404，而重载也"修不回来"。
  `client/**` 的改动会热重载。判断办法：日志里有没有**新的** `已注册 provider …（实例 xxxx）`。
- 不重启也能确认文件本身没问题：`node test/live/boot-path-check.mjs`（独立进程里真实跑 `apply()`）。
- 提交前跑 `npm test`。新增行为请补单测；面板相关的改动至少让 `test/unit/client.mjs` 的
  渲染断言覆盖到（它用一个小号 React **真的渲染**面板，缺 helper / 缺词典键会当场报错）。
- 面板外观改动后跑 `node test/live/ui-preview.mjs` 并用截图对比（输出在 `%TEMP%`）。

## 在线探针

需要真实账号（`$DSH_HOME/.credentials.yaml` 里的 `WORKBUDDY_INTL_TOKEN` / `WORKBUDDY_CN_TOKEN`），
所以**不会**在 CI 里跑。常用：

```sh
node test/live/host-log-tail.mjs 关键字      # 按 UTF-8 读宿主日志（PowerShell 会乱码）
node test/live/picker-contract-check.mjs     # 适配器实际给模型选择器什么
node test/live/harness-contract-replay.mjs   # 复刻 harness 校验，定位"选择器整组消失"
node test/live/availability-sweep.mjs cn     # 可用性全量探测
node test/live/leak-scan.mjs                 # 发布前必跑：账户信息/凭据泄露扫描
```

完整清单在协议文档附录。

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
