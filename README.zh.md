# dsh-quota-panel

[English](README.md) | 中文

**dsh-quota-panel** 是 DeepSeek Harness（DSH）**网页端（`dsh web`）的供应商额度/余额状态组件**。
它驻留在产品界面右下角，监控你配置过 API Key 的每一个 AI 供应商，
一眼看清还剩多少余额/额度——DeepSeek、OpenRouter、SiliconFlow、Moonshot、
StepFun、xAI、智谱 GLM、OpenCode Go，one-api / new-api 风格的聚合站，
以及各家 **Coding Plan**（智谱 GLM Coding、Z.AI、Kimi Coding、MiniMax
Coding 国际/国内）：5 小时窗口、周配额与搜索额度一目了然。

v0.5 起为**双面插件** + **内置供应商目录自动发现**：安装并重启 `dsh web` 后，
凡是 key 能解析的供应商都会自动出现在面板上——**零配置**。
它**零 npm 依赖**，也**不需要 `allowBuilds` 构建授权**。

## 效果图（真实浏览器渲染）

收起胶囊，浅色：

![胶囊（浅色）](docs/screenshot-light.png)

展开卡片，浅色：

![展开（浅色）](docs/screenshot-light-expanded.png)

设置面板（⚙），浅色：

![设置（浅色）](docs/screenshot-light-settings.png)

收起胶囊，深色：

![胶囊（深色）](docs/screenshot-dark.png)

展开卡片，深色：

![展开（深色）](docs/screenshot-dark-expanded.png)

设置面板（⚙），深色：

![设置（深色）](docs/screenshot-dark-settings.png)

## 支持的功能

- **自动发现** —— 宿主侧内置常见供应商目录，每项声明该供应商标准的 credential
  引用名；**key 能解析（`$DSH_HOME/.credentials.yaml` / `.env` / 环境变量）的供应商
  自动出现在面板上**，零配置；删除 key 行即消失。DSH 没有凭据枚举 API，
  因此每个刷新周期都会探测一次目录。
- **两种尺寸** —— 收起：极简胶囊，每个账户一个「独立状态点 + 数值」对
  （`● ¥58.36 · ● 45%`）；展开：完整卡片，每个供应商一行（状态点、名称、主数值、
  次级信息，用量型供应商还有进度条）。
- **自动刷新** —— 跟随配置间隔（默认 60 秒），页面隐藏时暂停；刷新按钮请求期间旋转，
  重复点击不会触发并发请求。
- **逐账户状态** —— 余额行按分级阈值（`critical <= warn <= healthy`），
  用量行按百分比（`error >= warn`）；只有异常的点和数值变色，其余保持平静。
  用量百分比使用手机电量式三色着色，与状态点独立。
- **设置面板（⚙）** —— 逐供应商显示开关、刷新间隔、逐供应商预警阈值、
  逐供应商 **HTTP(S) 代理 URL**、「恢复默认」。全部本地设置即时生效，
  保存在浏览器 localStorage，绝不写入 profile 或上传。
- **按行 HTTP(S) 代理** —— 为无法直连的供应商配置代理（见下）。
- **Coding Plan 用量窗口** —— 智谱 / Z.AI / Kimi / MiniMax 套餐渲染为用量行：
  5 小时窗口、周配额与（GLM/Z.AI）搜索车道，各带重置倒计时；
  套餐没有的窗口显示 `—`，绝不伪造 0%。
- **one-api / new-api 聚合站** —— 内置 `openai-billing` 格式适配聚合站仪表盘。
- **主题跟随** —— 完全使用 Harness 设计 Token（`--dsw-alias-*`、`--dsw-static-*`、
  `--dsw-shadow-*`、`--dsw-font-*`）驱动，token 缺失时有合理 fallback，
  自动跟随产品主题（浅色/深色），不携带自己的配色。
- **构架即安全** —— API Key 绝不进入浏览器；浏览器只与仅回环的 RPC 通道通信，
  只接收归一化视图（见「实现逻辑」）。

## 不支持的功能（规划中）

- **usage-only 供应商** —— OpenAI、Anthropic、Together、Groq、Mistral、Cohere、
  DashScope、百川没有公开的「剩余余额」接口，只有 usage/cost 类查询
  （通常需要 admin key 与时间窗参数，语义是「已花多少」而非「还剩多少」）。
  计划作为独立的 usage 型行接入，显示月度花费（首选 Anthropic Admin API 与
  OpenAI usage API）。
- **仅 Cookie / CLI 的 Coding Plan** —— 通义 Token Plan（百炼控制台）、小米 MiMo
  Token Plan、Qoder 与豆包的配额页没有 API-key 查询端点：需要网页 Cookie、
  `arkcli` 命令行或聊天接口限频探测（依据
  [CodexBar](https://github.com/steipete/CodexBar/tree/main/docs) 的调研）。
  本插件只使用 API key，在官方提供 API-key 端点前无法接入。
- **socks5 代理** —— 仅接受 HTTP/HTTPS 代理（socks URL 会被拒绝并给出清晰的单行错误）。
- **自定义适配器** —— 无法从 profile 扩展新的上游格式；`format` 值超出内置集合时
  在挂载时 fail loud。
- **多位置挂载** —— 组件只存在于 `shell.overlay` 槽位（右下角），
  不支持侧边栏、顶栏或状态栏位置。

## 实现逻辑

```
┌─────────────── browser (lib/client.js) ───────────────┐
│  shell.overlay 槽位 → 胶囊 / 卡片 / 设置面板           │
│  localStorage: 显示开关 · 间隔 · 阈值 ·               │
│                代理 URL（前端设置）                   │
└──────────────┬─────────────────────────────────────────┘
               │ 仅回环 Connection RPC: /dsh-quota-panel
               │   specs（渲染提示，不含凭据）
               │   fetch-all { proxy: {rowId: url} } → 归一化视图
┌──────────────▼────────────── host (lib/index.js) ──────┐
│  ctx.credentials → API Key（绝不离开宿主）              │
│  目录探测 → 自动发现（13 个内置供应商）                 │
│  逐行请求 → 代理引擎（CONNECT 隧道 / 绝对 URI）→ 上游 JSON │
│  归一化 → {balance | usage | info} 视图模型            │
└─────────────────────────────────────────────────────────┘
```

- **宿主侧**（`lib/index.js`）注册一条仅限回环的 Connection RPC 通道
  `/dsh-quota-panel`，两个端点：
  - `specs` —— 解析后的行，只含渲染提示（id、label、行类型、货币、阈值分级、
    窗口标签、已配置的代理名）。不含凭据，不含 endpoint。
  - `fetch-all` —— 拉取每个可见行，把上游响应**归一化为通用视图模型**
    （`balance` / `usage` / `info`），返回 `{rows: [{id, view} | {id, error}], fetchedAt}`。
    上游原始 JSON 与 key 一样留在宿主侧；单行失败不影响其他行。
- **自动发现** —— DSH 的凭据库没有枚举 API，因此宿主侧在每个刷新周期探测目录项
  的标准引用名；key 能解析的条目加入面板，解析不到的跳过（只有通过 `providers`
  显式配置的行，key 缺失才会给出清晰的单行错误）。
- **代理引擎** —— 零依赖手写 `proxiedGetJson`：https 目标走 HTTP `CONNECT` 隧道
  （TLS over 隧道），http 目标走绝对 URI 转发。每行独立 15 秒超时、1 MB 响应上限。
  代理选择优先级：**前端设置面板 > profile 配置 > 直连**。
- **阈值判断发生在客户端** —— 基于 `specs` 提示，因此本地阈值覆盖无需重新拉取；
  profile 阈值随 `specs` 下发，前端设置在其之上本地覆盖。
- **配置校验** —— 导出的 `Config` schema（vendor 的 schemastery）声明结构与默认值；
  跨字段约束（id 唯一、`critical <= warn <= healthy`、代理引用存在、catalog 覆盖键合法）
  由宿主侧在挂载时校验，失败即报错（fail loud）。
- **DOM 安全** —— 卡片只用 `createElement`/`textContent` 构建 DOM，API 返回值绝不
  经过 `innerHTML`；技术错误（401、超时、凭据缺失、代理拒绝）只写入 `title` 悬停提示
  或行内错误文案。

## 需要的配置

**开箱即用：什么都不用配。** 安装、重启，key 能解析的供应商自动出现。
下表只用于调优。

所有键都可选——结构与默认值在导出的 `Config` schema 里，profile patch 可省略一切
带默认值的字段。

| 键 | 含义 | 默认值 |
|---|---|---|
| `auto` | 探测内置目录，key 已配置的供应商自动上板 | `true` |
| `hide` | 要隐藏的行 id 列表（目录行与显式行都生效） | `[]` |
| `proxies` | 代理定义 `{<名称>: "http://host:port"}`，仅 HTTP(S) | `{}` |
| `catalog` | 对自动行的局部覆盖 `{<目录id>: {...}}` | `{}` |
| `refreshMs` | 自动刷新间隔 | 60000 |
| `providers` | 显式行；同 id 整体替换目录行 | `[]` |

`catalog` 每项可覆盖：`label` / `endpoint` / `format` / `proxy` / `refs`（探测的
credential 引用名，UPPER_SNAKE）/ `balanceTiers` / `warnPercent` / `errorPercent` /
`windowLabels`。

显式 `providers` 字段：

| 字段 | 含义 | 默认值 |
|---|---|---|
| `id` | 行标识（RPC 行按 id 对齐），`^[a-z0-9-]+$` | 必填 |
| `label` | 卡片上的提供方名称 | 必填 |
| `credential` | 凭据引用（`$DSH_HOME/.credentials.yaml` 或环境变量） | 必填 |
| `endpoint` | 额度 JSON 接口；`openai-billing` 格式时为聚合站 base URL | 必填 |
| `format` | 行适配器（见下表） | `deepseek-balance` |
| `proxy` | `proxies` 中定义的代理名；缺省直连 | — |
| `balanceTiers` | （余额型）`{critical, warn, healthy}` 分级阈值 | `{10, 20, 50}` |
| `lowBalance` | 旧版别名，等价于 `balanceTiers.warn` | — |
| `windowLabels` | （usage 类格式）用量窗口的标签 | `{滚, 周, 月}` |
| `warnPercent` / `errorPercent` | （用量型）阈值 | 70 / 90 |

### 内置供应商目录（自动发现）

| 供应商 | 探测的 credential 引用 | 查询端点 | 行类型 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance` | ¥余额 |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1/credits` | $余额（购入 − 已用） |
| SiliconFlow | `SILICONFLOW_API_KEY` | `api.siliconflow.cn/v1/user/info` | ¥余额 |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | `api.moonshot.cn/v1/users/me/balance` | ¥余额 |
| MiniMax Coding（国际） | `MINIMAX_API_KEY` | `www.minimax.io/v1/token_plan/remains` | 5 小时提示词用量% |
| MiniMax Coding（国内） | `MINIMAX_CN_API_KEY` | `api.minimaxi.com/v1/token_plan/remains` | 5 小时提示词用量% |
| StepFun 阶跃 | `STEP_API_KEY` / `STEPFUN_API_KEY` | `api.stepfun.com/v1/accounts` | ¥余额（悬停看现金/赠金） |
| xAI | `XAI_API_KEY` | `api.x.ai/v1/billing/credits` | $余额 |
| 智谱 GLM | `ZHIPU_API_KEY` / `GLM_API_KEY` | `open.bigmodel.cn/api/monitor/usage/quota/limit` | 文本行（配额剩余/总数；智谱无公开余额接口） |
| 智谱 GLM Coding | `ZAI_CODING_CN_API_KEY` | `open.bigmodel.cn/api/monitor/usage/quota/limit` | 套餐窗口（5h tokens / 周 / 搜索） |
| Z.AI GLM Coding | `ZAI_API_KEY` | `api.z.ai/api/monitor/usage/quota/limit` | 套餐窗口（5h tokens / 周 / 搜索） |
| Kimi Coding | `KIMI_API_KEY` | `api.kimi.com/coding/v1/usages` | 用量%（5h 限频 + 周请求池） |
| OpenCode Go | `OPENCODE_GO_API_KEY` | `opencode.ai/zen/go/v1/usage` | 三窗口用量% |

另内置 **`openai-billing`** 格式，适配 one-api / new-api 等聚合站：`endpoint` 配
聚合站 base URL，宿主侧请求 `{base}/v1/dashboard/billing/subscription`
（`hard_limit_usd`）与 `{base}/v1/dashboard/billing/usage`（`total_usage`）；
剩余 = 上限 − 已用（$）。聚合站域名各不相同，因此只支持显式配置行。

### 内置 format

| format | 行类型 | 上游响应形态 |
|---|---|---|
| `deepseek-balance` | ¥余额 | `{ balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` |
| `openrouter-credits` | $余额 | `{ data: { total_credits, total_usage } }` |
| `siliconflow-balance` | ¥余额 | `{ data: { balance, chargeBalance, totalUsage } }` |
| `moonshot-balance` | ¥余额 | `{ data: { total_balance } }` |
| `minimax-remains` | 用量% | `{ base_resp, model_remains: [{ current_interval_total_count, current_interval_remaining_percent 或各计数别名, end_time }] }`（按剩余反推已用%） |
| `stepfun-accounts` | ¥余额 | `{ balance, total_cash_balance, total_voucher_balance }` |
| `xai-credits` | $余额 | `{ total: { val } }`（分 → 元） |
| `openai-billing` | $余额 | 聚合站 `dashboard/billing` 两接口 |
| `zhipu-quota` | 文本 | `{ code: 200, data: { limits: [{ remaining, number }] } }`（无 `remaining` 的条目回退显示 `percentage`） |
| `opencode-usage` | 用量% | `{ usage: { rolling|weekly|monthly: { percent, resetsAt } } }` |
| `zai-coding-quota` | 用量% | `{ code: 200, data: { limits: [{ type: TOKENS_LIMIT \| TIME_LIMIT, unit, number, percentage, currentValue, usage, nextResetTime }] } }` —— 最短 TOKENS_LIMIT → 5h 窗口，最长 → 周，TIME_LIMIT → 搜索车道 |
| `kimi-coding-usage` | 用量% | `{ usage: { limit, used, resetTime }, limits: [{ window, detail: { limit, used, resetTime } }] }` —— 周请求池 + 第一个 5h 窗口 |

### 代理（部分供应商无法直连时）

在**前端设置面板（⚙ → 代理）**逐供应商配置：填一个 HTTP(S) 代理 URL
（如 `http://127.0.0.1:7890`，可带 user:pass），保存在浏览器 localStorage，即时生效——
留空即回到 profile 配置或直连。请求仍由宿主侧执行：浏览器把每行的代理 URL 随
`fetch-all` payload 发给宿主，宿主校验（仅 http/https，socks 拒绝）后经该代理请求
上游——key 照旧不出宿主。

profile 配置里的 `proxies` + 行级 `proxy` / `catalog.<id>.proxy` 仍可用，
作为**默认代理**（前端留空时生效）。优先级：**前端设置 > profile 配置 > 直连**。

```yaml
# profile 级默认代理示例（前端 ⚙ 面板可逐行覆盖）
- id: quota-panel
  name: 'dsh-quota-panel'
  config:
    proxies:
      home: http://127.0.0.1:7890     # clash / v2rayN 等本地代理的 http 端口
    catalog:
      openrouter:
        proxy: home                    # OpenRouter 默认经代理（前端可覆盖）
    providers:
      - id: my-agg
        label: 我的聚合站
        credential: AGG_API_KEY
        endpoint: https://agg.example  # openai-billing 用 base URL
        format: openai-billing
        proxy: home
```

### 阈值默认值

DeepSeek 余额（`balanceTiers {critical: 10, warn: 20, healthy: 50}`）：

| 余额 | 状态 | 次级信息 |
|---|---|---|
| `<= 10` | error（红点 + 红数值） | 建议充值 |
| `10 < x <= 20` | warn（琥珀色） | 余额紧张 |
| `20 < x <= 50` | ok | 余额正常 |
| `> 50` | ok | 余额充足 |

OpenCode 用量（`high = max(滚动, 每周, 每月)`）：

| 用量 | 状态 |
|---|---|
| `< warnPercent` | ok（绿点，DeepSeek 蓝进度条） |
| `>= warnPercent` | warn（琥珀点 + 进度条） |
| `>= errorPercent` | error（红点 + 进度条） |

## 安装

```sh
# 跟踪 main（每次安装取最新提交）
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel"
# 或锁定到自动打出的版本 tag（见 .github/workflows/tag-release.yml）
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel#v0.6.0"
# 重启 `dsh web`（bundle 层与 client 模块图在启动时生效）
```

安装后建议刷新一次浏览器页面。零 npm 依赖（schema 库 schemastery + cosmokit，
均 MIT，已 vendor 进 `lib/vendor/` 并以相对路径导入），无需 `allowBuilds` 构建授权。

包声明了 `dsh.bundle.patch`（宿主侧自动激活为 profile 层）和 `dsh.client`
manifest（浏览器侧自动进入 `__DSH_BOOT__` 模块图，`immediately: true` 随壳预取）。

## 致谢

本插件站在社区工作的肩膀上——感谢：

- [yingjunnan/dsh-deepseek-quota](https://github.com/yingjunnan/dsh-deepseek-quota)
  —— DSH 网页端右下角 DeepSeek 余额卡片的原作（自动刷新 + 手动刷新）；
  胶囊/卡片的交互模型直接受它启发。
- [Ghost011118/dsh-balance-meter](https://github.com/Ghost011118/dsh-balance-meter)
  —— DSH 网页端的 DeepSeek 账户余额与会话花费读数；其面板设计启发了展开卡片的布局。
- [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)
  —— 社区插件目录，让我们发现了上面这些项目以及更广阔的 DSH 插件生态。
- [hanmumuHL/check_balance](https://github.com/hanmumuHL/check_balance) ——
  DeepSeek 余额 API 端点调研，为目录条目提供了依据。
- [steipete/CodexBar](https://github.com/steipete/CodexBar) —— 其供应商文档
  （z.ai/GLM 套餐窗口语义、Kimi Code 用量接口、MiMo / 通义 / Qoder /
  豆包的认证调研）直接塑造了本插件的套餐适配器与不支持清单。
- [PowerUserZ/OpenTokenUsage](https://github.com/PowerUserZ/OpenTokenUsage)
  —— 记录了 MiniMax `token_plan/remains` 的响应怪癖与 Kimi Code 用量端点。
- [schemastery](https://github.com/shigma/schemastery) 与
  [cosmokit](https://github.com/cosmokit/cosmokit)（均 MIT）—— vendor 在
  `lib/vendor/` 下的 schema 库。

## 更新日志

- **v0.6.0** —— 套餐（Coding Plan）支持：目录新增 智谱 GLM Coding
  （`ZAI_CODING_CN_API_KEY`）、Z.AI GLM Coding（`ZAI_API_KEY`）、Kimi Coding
  （`KIMI_API_KEY`）、MiniMax Coding 国际/国内（`MINIMAX_API_KEY` /
  `MINIMAX_CN_API_KEY`）；新增 `zai-coding-quota`（5h/周 token 窗口 +
  搜索车道）与 `kimi-coding-usage`（5h 限频 + 周请求池）适配器；
  `minimax-remains` 按真实 `model_remains` 响应重写（改为用量行）；
  `zhipu-quota` 对无 `remaining` 的条目回退显示 `percentage`；用量行缺失
  窗口显示 `—`（标签取自 `windowLabels`，不再写死 rolling/weekly/monthly）。
- **v0.5.0** —— 内置供应商目录 + 自动发现（探测 credential 引用，9 家供应商零配置上板）；
  新增 8 种 format 适配器（含 one-api/new-api 聚合站 `openai-billing`）；`fetch-all`
  契约改为宿主侧归一化视图（balance / usage / info），上游 JSON 不再下发；按行 HTTP(S)
  代理（CONNECT 隧道 / 绝对 URI，零依赖），**代理在 ⚙ 设置面板逐供应商配置**
  （localStorage，优先于 profile 的 `proxies` / `proxy`）；新增 `auto` / `hide` /
  `proxies` / `catalog` 配置键。
- **v0.4.0** —— 双面重构：宿主侧改为 loopback Connection RPC 通道（`specs` /
  `fetch-all`）+ `Config` schema；浏览器侧迁入 `dsh.client` manifest + `shell.overlay`
  槽位（React）；新增 ⚙ 设置面板（供应商显示 / 刷新间隔 / 预警阈值，localStorage 持久化）。
- **v0.3.0** —— 双尺寸：收起为极简胶囊（每账户独立状态点 + 电量式三色数值），点击展开完整卡片。
- **v0.2.0** —— Harness 原生卡片：设计 Token 驱动、余额分级阈值、用量进度条。
- **v0.1.0** —— 初版悬浮面板：服务端额度代理 + 页面角标。

## 安全

- API Key 仅由宿主侧通过 `ctx.credentials` 解析，只用于宿主侧到提供方的请求；浏览器只通过
  回环 RPC 通道 `/dsh-quota-panel` 通信，`specs` 端点只下发渲染提示（标签/类型/阈值），
  不含 credential 与 endpoint；v0.5 起 `fetch-all` 也只下发归一化视图，上游原始 JSON 同样
  不出宿主。
- 卡片只使用 `createElement`/`textContent` 构建 DOM，API 返回值绝不经过 `innerHTML`；
  技术错误（401、超时、凭据缺失、代理拒绝）只写入 `title` 悬停提示或行内错误文案，
  单行失败不影响其他行。

## 待办

- **usage-only 供应商**（OpenAI / Anthropic / Together / Groq / Mistral / Cohere /
  DashScope / 百川）作为独立的 usage 型行接入，显示月度花费而非余额
  （首选 Anthropic Admin API 与 OpenAI usage API）。
- socks5 代理支持（当前仅 HTTP/HTTPS）。

## 本地开发

```sh
# 零依赖，无需 npm install。升级 vendor 时替换 lib/vendor/ 下两个文件并改写
# schemastery.mjs 第一行的 cosmokit 导入为 "./cosmokit.js" 即可。
# 双面检查：宿主侧 RPC 契约 + 目录发现/代理引擎（对真实本地 server 实测）
#          + 浏览器侧槽位注册/设置面板表面
node scripts/test-page-script.mjs
```

## License

MIT
