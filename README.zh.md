# dsh-quota-panel

[English](README.md) | 中文

**dsh-quota-panel** 是 DeepSeek Harness（DSH）网页端的**提供方额度/余额状态组件**插件。

v0.5 起为**双面包插件**（dual-face）+ **内置供应商目录自动发现**：

- **宿主半**（`lib/index.js`）：注册一条仅限回环的 Connection RPC 通道
  `/dsh-quota-panel`（端点 `specs` / `fetch-all`）。API Key 通过 `ctx.credentials`
  在服务端解析，**绝不进入浏览器**；上游额度接口由宿主侧以
  `Authorization: Bearer <key>` 代理访问（可选经 HTTP 代理转发），
  并把上游响应**归一化为通用视图模型**（余额 / 用量 / 文本），
  上游 JSON 细节与密钥一样不下发，逐行捕获错误。
- **浏览器半**（`lib/client.js`，经 package.json 的 `dsh.client` manifest 由
  `/plugins/dsh-quota-panel/client.js` 下发）：注册 `shell.overlay` 槽位，用 React
  渲染右下角的 Harness 原生风格状态组件，两种尺寸：

- **收起（默认）** —— 极简胶囊：每个账户一个「独立状态点 + 数值」对
  （如 `● ¥58.36 · ● 45%`），互不干扰——哪个账户紧张只有它的点变色，
  不用文字标签，一眼扫过即可；点击展开。
- **展开** —— 完整卡片：「模型额度」标题栏（刷新 **⚙ 设置** / 收起按钮）+
  每个提供方一行结构化信息（状态点、名称、主数值、次级信息，用量型提供方
  还有进度条），点收起按钮缩回胶囊。

两种尺寸都自动刷新（页面隐藏时暂停）；刷新按钮旋转反馈，重复点击不会并发请求。

## 内置供应商目录（自动发现）

宿主半内置常见供应商目录。目录项声明各家标准的 credential 引用名，
**key 能解析（`$DSH_HOME/.credentials.yaml` / `.env` / 环境变量）的供应商自动出现在面板上**，
无需任何配置；key 消失则行自动隐藏。无需翻墙的国内供应商直连，
国际供应商可通过 `proxies` 配置按行走代理（见下）。

| 供应商 | 探测的 credential 引用 | 查询端点 | 行类型 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance` | ¥余额 |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1/credits` | $余额（购入 − 已用） |
| SiliconFlow | `SILICONFLOW_API_KEY` | `api.siliconflow.cn/v1/user/info` | ¥余额 |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | `api.moonshot.cn/v1/users/me/balance` | ¥余额 |
| MiniMax | `MINIMAX_API_KEY` | `api.minimaxi.com/v1/token_plan/remains` | ¥余额 |
| StepFun 阶跃 | `STEP_API_KEY` / `STEPFUN_API_KEY` | `api.stepfun.com/v1/accounts` | ¥余额（悬停看现金/赠金） |
| xAI | `XAI_API_KEY` | `api.x.ai/v1/billing/credits` | $余额 |
| 智谱 GLM | `ZHIPU_API_KEY` / `GLM_API_KEY` | `open.bigmodel.cn/api/monitor/usage/quota/limit` | 文本行（配额剩余/总数；智谱无公开余额接口） |
| OpenCode Go | `OPENCODE_GO_API_KEY` | `opencode.ai/zen/go/v1/usage` | 三窗口用量% |

另内置 **`openai-billing`** 格式，适配 one-api / new-api 等聚合站：
`endpoint` 配聚合站 base URL，宿主半请求
`{base}/v1/dashboard/billing/subscription`（`hard_limit_usd`）与
`{base}/v1/dashboard/billing/usage`（`total_usage`），剩余 = 上限 − 已用（$）。
聚合站域名各不相同，因此只支持显式配置行（见下）。

**无公开余额/剩余接口的供应商**（OpenAI、Anthropic、Together、Groq、Mistral、
Cohere、DashScope/通义、百川）目前不支持，见文末「待办」。

## 设置面板（⚙）

展开卡片后，刷新按钮旁有**齿轮入口**，点开即得三组本地设置（即时生效，
保存在浏览器 localStorage，不写 profile、不上传）：

- **显示供应商** —— 逐个勾选要显示的提供方（全部隐藏时胶囊提示「已全部隐藏」，
  仍可进入设置重新开启）；
- **刷新间隔** —— 跟随配置（默认）或 15 秒 ~ 5 分钟固定间隔；
- **预警阈值** —— 逐提供方覆盖：余额型为「预警 ¥/$」（自动推得 critical = 值/2），
  用量型为「预警 %」（error 自动取 max(配置值, 预警+1)）；文本行无阈值；留空恢复配置默认；
- **恢复默认** —— 一键清空全部本地设置。

胶囊里的用量百分比按**手机电量式三色**着色：健康绿、紧张琥珀、告急红，
与状态点独立对应；余额数值仅在其状态告警时着色。

组件完全使用 Harness 设计 Token（`--dsw-alias-*`、`--dsw-static-*`、
`--dsw-shadow-*`、`--dsw-font-*`）驱动，token 缺失时有合理的 fallback，
因此自动跟随产品主题（浅色/深色），不携带自己的配色。

> 下方的旧截图拍摄于 v0.3（尚无 ⚙ 设置入口），胶囊/卡片主体样式未变。

## 效果图

收起胶囊（浅色 / 深色）：

![胶囊（浅色）](docs/capsule-light.png)
![胶囊（深色）](docs/capsule-dark.png)

展开卡片（浅色 / 深色）：

![面板（浅色）](docs/panel-light.png)
![面板（深色）](docs/panel-dark.png)

完整页面（小胶囊状态，浅色 / 深色）：

![完整页面（浅色）](docs/screenshot-light.png)
![完整页面（深色）](docs/screenshot-dark.png)

## 安装

```sh
# 跟踪 main（每次安装取最新提交）
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel"
# 或锁定到自动打出的版本 tag（见 .github/workflows/tag-release.yml）
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel#v0.5.0"
# 重启 `dsh web`（bundle 层与 client 模块图在启动时生效）
```

安装后建议刷新一次浏览器页面。零 npm 依赖（schema 库已 vendor），无需
`allowBuilds` 构建授权。

包声明了 `dsh.bundle.patch`（宿主半自动激活为 profile 层）和 `dsh.client`
manifest（浏览器半自动进入 `__DSH_BOOT__` 模块图，`immediately: true` 随壳预取）。

从本地改造版安装（开发）：

```sh
dsh plugin --profile web add "link:/path/to/dsh-quota-panel"
# 或手动把 profile package.json 依赖改为 link: 后 pnpm install
```

> 插件零 npm 依赖：schema 库（schemastery + cosmokit，均 MIT）已 vendor 进
> `lib/vendor/` 并以相对路径导入，因此 `link:` 安装**不需要**仓库自带
> node_modules——Node 从仓库真实路径向上解析不到 dsh 内置包，vendor 化正是为此。

## 配置

配置由导出的 **`Config` schema**（vendor 的 schemastery）声明结构与默认值，
profile patch 里可省略一切带默认值的字段；跨字段约束（id 唯一、
`critical <= warn <= healthy`、proxy 引用存在、catalog 覆盖键合法）
由宿主半在挂载时校验，错误即失败（fail loud）。

| 字段 | 含义 | 默认值 |
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

显式 `providers` 每项字段：

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
| `windowLabels` | （opencode-usage）三个窗口的标签 | `{滚, 周, 月}` |
| `warnPercent` / `errorPercent` | （用量型）阈值 | 70 / 90 |

内置 format（决定行类型与货币）：

| format | 行类型 | 上游响应形态 |
|---|---|---|
| `deepseek-balance` | ¥余额 | `{ balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` |
| `openrouter-credits` | $余额 | `{ data: { total_credits, total_usage } }` |
| `siliconflow-balance` | ¥余额 | `{ data: { balance, chargeBalance, totalUsage } }` |
| `moonshot-balance` | ¥余额 | `{ data: { total_balance } }` |
| `minimax-remains` | ¥余额 | `{ data: { remain } }` |
| `stepfun-accounts` | ¥余额 | `{ balance, total_cash_balance, total_voucher_balance }` |
| `xai-credits` | $余额 | `{ total: { val } }`（分 → 元） |
| `openai-billing` | $余额 | 聚合站 `dashboard/billing` 两接口 |
| `zhipu-quota` | 文本 | `{ code: 200, data: { limits: [{ remaining, number }] } }` |
| `opencode-usage` | 用量% | `{ usage: { rolling\|weekly\|monthly: { percent, resetsAt } } }` |

### 代理（部分供应商无法直连时）

`proxies` 定义命名代理（支持 `http://` 与 `https://`，URL 里可带
`user:pass`）；**没有任何行默认走代理**，每行显式指定才会经过：

```yaml
- id: quota-panel
  name: 'dsh-quota-panel'
  config:
    proxies:
      home: http://127.0.0.1:7890     # clash / v2rayN 等本地代理的 http 端口
    catalog:
      openrouter:
        proxy: home                    # 仅 OpenRouter 经代理探测/请求
    providers:
      - id: my-agg
        label: 我的聚合站
        credential: AGG_API_KEY
        endpoint: https://agg.example  # openai-billing 用 base URL
        format: openai-billing
        proxy: home
```

实现为零依赖手写：https 目标走 HTTP `CONNECT` 隧道（TLS over 隧道），
http 目标走绝对 URI 转发；每行独立 15s 超时与错误捕获，代理故障只记该行
错误（如 `proxy CONNECT failed: HTTP 403`），不影响其他行。socks5 不支持。

### DeepSeek 余额分级

默认 `balanceTiers {critical: 10, warn: 20, healthy: 50}`：

| 余额 | 状态 | 次级信息 |
|---|---|---|
| `<= 10` | error（红点 + 红数值） | 建议充值 |
| `10 < x <= 20` | warn（琥珀色） | 余额紧张 |
| `20 < x <= 50` | ok | 余额正常 |
| `> 50` | ok | 余额充足 |

### OpenCode 用量状态

`high = max(滚动, 每周, 每月)`：

| 用量 | 状态 |
|---|---|
| `< warnPercent` | ok（绿点，DeepSeek 蓝进度条） |
| `>= warnPercent` | warn（琥珀点 + 进度条） |
| `>= errorPercent` | error（红点 + 进度条） |

## 更新日志

- **v0.5.0** — 内置供应商目录 + 自动发现（探测 credential 引用，9 家供应商零配置上板）；
  新增 8 种 format 适配器（含 one-api/new-api 聚合站 `openai-billing`）；
  `fetch-all` 契约改为宿主侧归一化视图（balance / usage / info），上游 JSON 不再下发；
  按行 HTTP(S) 代理（CONNECT 隧道 / 绝对 URI，零依赖）；新增 `auto` / `hide` /
  `proxies` / `catalog` 配置键。
- **v0.4.0** — 双面包重构：宿主半改为 loopback Connection RPC 通道（`specs` /
  `fetch-all`）+ `Config` schema；浏览器半迁入 `dsh.client` manifest + `shell.overlay`
  槽位（React）；新增 ⚙ 设置面板（供应商显示 / 刷新间隔 / 预警阈值，localStorage 持久化）。
- **v0.3.0** — 双尺寸：收起为极简胶囊（每账户独立状态点 + 电量式三色数值），点击展开完整卡片。
- **v0.2.0** — Harness 原生卡片：设计 Token 驱动、余额分级阈值、用量进度条。
- **v0.1.0** — 初版悬浮面板：服务端额度代理 + 页面角标。

## 安全

- API Key 仅由宿主半通过 `ctx.credentials` 解析，只用于宿主侧到提供方的请求；
  浏览器只通过回环 RPC 通道 `/dsh-quota-panel` 通信，`specs` 端点只下发渲染提示
  （标签/类型/阈值），不含 credential 与 endpoint；v0.5 起 `fetch-all` 也只下发
  归一化视图，上游原始 JSON 同样不出宿主。
- 卡片只使用 `createElement`/`textContent` 构建 DOM，API 返回值绝不经过
  `innerHTML`；技术错误（401、超时、凭据缺失、代理拒绝）只写入 `title` 悬停提示
  或行内错误文案，单行失败不影响其他行。

## 待办

- **usage-only 供应商**：OpenAI / Anthropic / Together / Groq / Mistral / Cohere /
  DashScope（通义）/ 百川无公开「余额」接口，仅有 usage/cost 类查询（多需 admin
  key 与时间窗参数，语义是「已花多少」而非「还剩多少」）。计划作为独立的
  usage 型行接入（首选 Anthropic Admin API 与 OpenAI usage API），
  显示月度花费而非余额。
- socks5 代理（当前仅 HTTP/HTTPS）。

## 本地开发

```sh
# 零依赖，无需 npm install。升级 vendor 时替换 lib/vendor/ 下两个文件并改写
# schemastery.mjs 第一行的 cosmokit 导入为 "./cosmokit.js" 即可。
# 双面检查：宿主半 RPC 契约 + 目录发现/代理引擎（对真实本地 server 实测）
#          + 浏览器半槽位注册/设置面板表面
node scripts/test-page-script.mjs
```

## License

MIT
