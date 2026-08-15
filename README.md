# dsh-quota-panel

English | [中文](README.zh.md)

**dsh-quota-panel** is a **provider quota / balance status widget** for the
DeepSeek Harness (DSH) **web surface** (`dsh web`). It sits in the
bottom-right corner of the product UI, watches every AI provider whose API
key you have configured, and tells you at a glance how much balance /
quota is left — DeepSeek, OpenRouter, SiliconFlow, Moonshot, StepFun,
xAI, Zhipu GLM, OpenCode Go, plus one-api / new-api style aggregators,
and the **coding plans** (智谱 GLM Coding, Z.AI, Kimi Coding, MiniMax
Coding global/CN) with 5-hour / weekly usage windows and search quota.

Since v0.5 it is a **dual-face plugin** with a **built-in provider catalog
and auto discovery**: install it, restart `dsh web`, and every provider
whose key resolves automatically appears on the panel — zero configuration.
It needs **no npm dependencies** and asks for **no `allowBuilds` authorization**.

## Screenshots (real browser rendering)

Collapsed capsule, light theme:

![capsule (light)](docs/screenshot-light.png)

Expanded card, light theme:

![expanded (light)](docs/screenshot-light-expanded.png)

Settings panel (⚙), light theme:

![settings (light)](docs/screenshot-light-settings.png)

Collapsed capsule, dark theme:

![capsule (dark)](docs/screenshot-dark.png)

Expanded card, dark theme:

![expanded (dark)](docs/screenshot-dark-expanded.png)

Settings panel (⚙), dark theme:

![settings (dark)](docs/screenshot-dark-settings.png)

## Supported features

- **Auto discovery** — the host half ships a catalog of well-known
  providers; each entry names the provider's standard credential
  references, and **every provider whose key resolves
  (`$DSH_HOME/.credentials.yaml` / `.env` / environment variables)
  appears on the panel automatically**, with zero config. Remove the key
  and the row disappears. No credential enumeration API exists in DSH, so
  the catalog is probed each refresh cycle.
- **Coding-plan usage windows** — GLM / Z.AI / Kimi / MiniMax coding
  plans render as usage rows: 5-hour window, weekly pool and (GLM/Z.AI)
  the web-search lane, each with its own reset countdown; windows the
  plan does not carry show `—` instead of a fabricated 0%.
- **Two sizes** — collapsed: a minimal capsule with one independent
  "status dot + value" pair per account (`● ¥58.36 · ● 45%`); expanded: a
  full card with a row per provider (status dot, name, primary value,
  secondary info, progress bar for usage-kind providers).
- **Auto refresh** — follows the configured interval (default 60 s), paused
  while the page is hidden; the refresh button spins during a fetch and
  repeated clicks never fire concurrent requests.
- **Per-account status** — balance rows are graded by tier
  (`critical <= warn <= healthy`), usage rows by percent
  (`error >= warn`); the offending dot/value alone recolors, others stay
  calm. Usage percentages use battery-style three-color grading, independent
  of the status dots.
- **Settings panel (⚙)** — per-provider visibility, refresh interval,
  per-provider warning thresholds, per-provider **HTTP(S) proxy URL**, and
  "restore defaults". All local settings apply immediately, persist to
  browser localStorage, and are never written to the profile or uploaded.
- **Per-row HTTP(S) proxy** — configure a proxy for providers that cannot
  be reached directly from your network (see below).
- **One-api / new-api aggregators** — the built-in `openai-billing`
  format adapts aggregator dashboards.
- **Theming** — driven entirely by Harness design tokens
  (`--dsw-alias-*`, `--dsw-static-*`, `--dsw-shadow-*`,
  `--dsw-font-*`) with sensible fallbacks, so it follows the product
  theme (light/dark) and ships no palette of its own.
- **Security by construction** — API keys never reach the browser; the
  browser talks only to a loopback-only RPC channel and receives only
  normalized views (see "How it works").

## Not supported (yet)

- **Usage-only providers** — OpenAI, Anthropic, Together, Groq, Mistral,
  Cohere, DashScope, Baichuan expose no public "remaining balance"
  endpoint, only usage/cost queries (usually admin keys + time windows,
  "spent" semantics rather than "remaining"). Planned as a separate
  usage row kind showing monthly spend (Anthropic Admin API and OpenAI
  usage API first).
- **Cookie / CLI-only coding plans** — the quota pages of Qwen Token Plan
  (Bailian console), Xiaomi MiMo Token Plan, Qoder and Doubao expose no
  API-key quota endpoint: they require web cookies, the `arkcli` CLI, or
  chat-endpoint rate-limit probes (per
  [CodexBar](https://github.com/steipete/CodexBar/tree/main/docs) research).
  This plugin only speaks API keys, so those plans cannot be wired in
  until an API-key endpoint appears.
- **socks5 proxies** — only HTTP/HTTPS proxies are accepted (a socks URL
  is rejected with a clear per-row error).
- **Custom adapters** — new upstream formats cannot be plugged in from the
  profile; a `format` value outside the built-in set fails loud at mount.
- **Multi-page placements** — the widget lives in the `shell.overlay`
  slot only (bottom-right corner), not in sidebars, headers, or the status
  bar.

## How it works

```
┌─────────────── browser (lib/client.js) ───────────────┐
│  shell.overlay slot → capsule / card / settings panel  │
│  localStorage: visibility · interval · thresholds ·    │
│                proxy URLs (frontend settings)          │
└──────────────┬─────────────────────────────────────────┘
               │ loopback-only Connection RPC: /dsh-quota-panel
               │   specs (render hints, no credentials)
               │   fetch-all { proxy: {rowId: url} } → normalized views
┌──────────────▼────────────── host (lib/index.js) ──────┐
│  ctx.credentials → API keys (never leave the host)      │
│  catalog probe → auto discovery (13 built-in providers) │
│  per-row fetch → proxy engine (CONNECT tunnel /         │
│                  absolute-URI) → upstream JSON          │
│  normalization → {balance | usage | info} view models   │
└─────────────────────────────────────────────────────────┘
```

- **Host half** (`lib/index.js`) registers one loopback-only Connection
  RPC channel `/dsh-quota-panel` with two endpoints:
  - `specs` — the resolved rows with render hints only (id, label, row
    kind, currency, threshold tiers, window labels, configured proxy name).
    No credentials, no endpoints.
  - `fetch-all` — fetches every visible row, normalizes each upstream
    response into a **generic view model** (`balance` / `usage` /
    `info`), and returns `{rows: [{id, view} | {id, error}], fetchedAt}`.
    Raw upstream JSON stays host-side like the keys; one failing row never
    affects the others.
- **Auto discovery** — because DSH's credential store has no enumeration
  API, the host half probes the catalog entries' standard refs each fetch
  cycle; every entry whose key resolves joins the panel, and entries with
  unresolvable keys are skipped (a missing key yields a clear per-row error
  only when it was explicitly configured via `providers`).
- **Proxy engine** — zero-dependency hand-rolled `proxiedGetJson`:
  https targets go through an HTTP `CONNECT` tunnel (TLS over the
  tunnel), http targets via absolute-URI forwarding. 15 s per-row timeout,
  1 MB body cap. Proxy selection precedence:
  **frontend settings panel > profile config > direct**.
- **Threshold judgement happens client-side** from the `specs` hints, so
  local threshold overrides apply without refetching; profile thresholds
  ship in `specs` and the frontend settings override them locally.
- **Config validation** — the exported `Config` schema (vendored
  schemastery) declares structure and defaults; cross-field constraints (id
  uniqueness, `critical <= warn <= healthy`, proxy references, catalog
  override keys) are validated host-side at mount and fail loud.
- **DOM safety** — the card builds DOM exclusively with
  `createElement`/`textContent`; API values never touch `innerHTML`;
  technical errors (401, timeout, missing credential, refused proxy) surface
  only in `title` tooltips or inline row text.

## Configuration

**Out of the box: nothing.** Install, restart, and any provider whose key
resolves appears automatically. The table below is only for tuning.

All keys are optional — the structure and defaults live in the exported
`Config` schema, so profile patches may omit every defaulted field.

| Key | Meaning | Default |
|---|---|---|
| `auto` | probe the built-in catalog; providers with a resolvable key join the panel | `true` |
| `hide` | row ids to drop (catalog and explicit rows alike) | `[]` |
| `proxies` | named proxy definitions `{<name>: "http://host:port"}`, HTTP(S) only | `{}` |
| `catalog` | partial overrides for auto-discovered rows `{<catalog-id>: {...}}` | `{}` |
| `refreshMs` | auto-refresh interval | 60000 |
| `providers` | explicit rows; a same-id entry replaces the catalog row wholesale | `[]` |

Each `catalog` override may set: `label` / `endpoint` / `format` /
`proxy` / `refs` (credential references to probe, UPPER_SNAKE) /
`balanceTiers` / `warnPercent` / `errorPercent` / `windowLabels`.

Explicit `providers` fields:

| Field | Meaning | Default |
|---|---|---|
| `id` | row id (RPC rows align by id), `^[a-z0-9-]+$` | required |
| `label` | provider name shown on the card | required |
| `credential` | credential reference (`$DSH_HOME/.credentials.yaml` or environment) | required |
| `endpoint` | quota JSON endpoint; base URL for `openai-billing` | required |
| `format` | row adapter (see table below) | `deepseek-balance` |
| `proxy` | a proxy name defined in `proxies`; absent = direct | — |
| `balanceTiers` | (balance rows) `{critical, warn, healthy}` | `{10, 20, 50}` |
| `lowBalance` | legacy alias for `balanceTiers.warn` | — |
| `windowLabels` | (usage-kind formats) labels for the usage windows | `{滚, 周, 月}` |
| `warnPercent` / `errorPercent` | (usage rows) thresholds | 70 / 90 |

### Built-in provider catalog (auto discovery)

| Provider | Credential refs probed | Endpoint | Row kind |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance` | ¥ balance |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter.ai/api/v1/credits` | $ balance (purchased − used) |
| SiliconFlow | `SILICONFLOW_API_KEY` | `api.siliconflow.cn/v1/user/info` | ¥ balance |
| Moonshot / Kimi | `MOONSHOT_API_KEY` | `api.moonshot.cn/v1/users/me/balance` | ¥ balance |
| MiniMax Coding (global) | `MINIMAX_API_KEY` | `www.minimax.io/v1/token_plan/remains` | 5h prompt usage % |
| MiniMax Coding (CN) | `MINIMAX_CN_API_KEY` | `api.minimaxi.com/v1/token_plan/remains` | 5h prompt usage % |
| StepFun | `STEP_API_KEY` / `STEPFUN_API_KEY` | `api.stepfun.com/v1/accounts` | ¥ balance (hover: cash/voucher) |
| xAI | `XAI_API_KEY` | `api.x.ai/v1/billing/credits` | $ balance |
| Zhipu GLM | `ZHIPU_API_KEY` / `GLM_API_KEY` | `open.bigmodel.cn/api/monitor/usage/quota/limit` | text row (quota remaining/total; no public balance API) |
| 智谱 GLM Coding | `ZAI_CODING_CN_API_KEY` | `open.bigmodel.cn/api/monitor/usage/quota/limit` | coding-plan windows (5h tokens / weekly / searches) |
| Z.AI GLM Coding | `ZAI_API_KEY` | `api.z.ai/api/monitor/usage/quota/limit` | coding-plan windows (5h tokens / weekly / searches) |
| Kimi Coding | `KIMI_API_KEY` | `api.kimi.com/coding/v1/usages` | usage % (5h rate limit + weekly request pool) |
| OpenCode Go | `OPENCODE_GO_API_KEY` | `opencode.ai/zen/go/v1/usage` | three-window usage % |

An additional **`openai-billing`** format adapts one-api / new-api style
aggregators: set `endpoint` to the aggregator base URL and the host half
requests `{base}/v1/dashboard/billing/subscription`
(`hard_limit_usd`) plus `{base}/v1/dashboard/billing/usage`
(`total_usage`); remaining = limit − used ($). Aggregator domains differ
per deployment, so this format is explicit-config only.

### Built-in formats

| format | Row kind | Upstream response shape |
|---|---|---|
| `deepseek-balance` | ¥ balance | `{ balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }` |
| `openrouter-credits` | $ balance | `{ data: { total_credits, total_usage } }` |
| `siliconflow-balance` | ¥ balance | `{ data: { balance, chargeBalance, totalUsage } }` |
| `moonshot-balance` | ¥ balance | `{ data: { total_balance } }` |
| `minimax-remains` | usage % | `{ base_resp, model_remains: [{ current_interval_total_count, current_interval_remaining_percent | …count aliases, end_time }] }` (remaining → used %) |
| `stepfun-accounts` | ¥ balance | `{ balance, total_cash_balance, total_voucher_balance }` |
| `xai-credits` | $ balance | `{ total: { val } }` (cents → dollars) |
| `openai-billing` | $ balance | aggregator `dashboard/billing` endpoints |
| `zhipu-quota` | text | `{ code: 200, data: { limits: [{ remaining, number }] } }` (limits without `remaining` fall back to `percentage`) |
| `opencode-usage` | usage % | `{ usage: { rolling|weekly|monthly: { percent, resetsAt } } }` |
| `zai-coding-quota` | usage % | `{ code: 200, data: { limits: [{ type: TOKENS_LIMIT \| TIME_LIMIT, unit, number, percentage, currentValue, usage, nextResetTime }] } }` — shortest TOKENS_LIMIT → 5h window, longest → weekly, TIME_LIMIT → search lane |
| `kimi-coding-usage` | usage % | `{ usage: { limit, used, resetTime }, limits: [{ window, detail: { limit, used, resetTime } }] }` — weekly pool + first 5h window |

### Proxy (providers that cannot be reached directly)

Configure per-provider proxies in the **frontend settings panel (⚙ →
代理)**: fill an HTTP(S) proxy URL (e.g. `http://127.0.0.1:7890`,
user:pass allowed), saved to browser localStorage, effective immediately —
leave it empty to fall back to the profile config or a direct connection.
Requests still run host-side: the browser sends each row's proxy URL in the
`fetch-all` payload, the host validates it (http/https only, socks
rejected) and fetches through it — keys still never leave the host.

The profile `proxies` map + row-level `proxy` /
`catalog.<id>.proxy` remain available as **default proxies** (used when
the frontend field is empty). Precedence:
**frontend settings > profile config > direct**.

```yaml
# example profile-level default proxy (the ⚙ panel can override per row)
- id: quota-panel
  name: 'dsh-quota-panel'
  config:
    proxies:
      home: http://127.0.0.1:7890     # local proxy http port (clash / v2rayN …)
    catalog:
      openrouter:
        proxy: home                    # OpenRouter via proxy by default
    providers:
      - id: my-agg
        label: My aggregator
        credential: AGG_API_KEY
        endpoint: https://agg.example  # base URL for openai-billing
        format: openai-billing
        proxy: home
```

### Threshold defaults

DeepSeek balance (`balanceTiers {critical: 10, warn: 20, healthy: 50}`):

| Balance | Status | Secondary info |
|---|---|---|
| `<= 10` | error (red dot + red value) | 建议充值 |
| `10 < x <= 20` | warn (amber) | 余额紧张 |
| `20 < x <= 50` | ok | 余额正常 |
| `> 50` | ok | 余额充足 |

OpenCode usage (`high = max(rolling, weekly, monthly)`):

| Usage | Status |
|---|---|
| `< warnPercent` | ok (green dot, DeepSeek-blue bar) |
| `>= warnPercent` | warn (amber dot + bar) |
| `>= errorPercent` | error (red dot + bar) |

## Install

```sh
# Track main (each install resolves to the latest commit)
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel"
# Or pin the auto-tagged release (see .github/workflows/tag-release.yml)
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel#v0.7.0"
# Restart `dsh web` (bundle layer and client module graph apply at boot)
```

Refresh the browser page once after installing. Zero npm dependencies (the
schema library — schemastery + cosmokit, both MIT — is vendored under
`src/vendor/` with relative-path imports), no `allowBuilds` authorization
needed.

The package declares `dsh.bundle.patch` (host half auto-activates as a
profile layer) and the `dsh.client` manifest (browser half auto-joins the
`__DSH_BOOT__` module graph, `immediately: true` prefetched with the shell).

## Acknowledgments

This plugin builds on community work — thanks to:

- [yingjunnan/dsh-deepseek-quota](https://github.com/yingjunnan/dsh-deepseek-quota)
  — the original bottom-right DeepSeek balance card for the DSH Web page
  (auto-refresh + manual refresh); the capsule/card interaction model is
  directly inspired by it.
- [Ghost011118/dsh-balance-meter](https://github.com/Ghost011118/dsh-balance-meter)
  — DeepSeek account balance and session cost readout for the DSH Web GUI;
  its panel design informed the expanded card layout.
- [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)
  — the community plugin catalog that surfaced the projects above and the
  broader DSH plugin ecosystem.
- [hanmumuHL/check_balance](https://github.com/hanmumuHL/check_balance) —
  endpoint research (DeepSeek balance API) that informed the catalog.
- [steipete/CodexBar](https://github.com/steipete/CodexBar) — its provider
  docs (z.ai/GLM coding-plan windows, Kimi Code usage API, MiMo / Qwen /
  Qoder / Doubao auth research) shaped the coding-plan adapters and the
  not-supported list.
- [PowerUserZ/OpenTokenUsage](https://github.com/PowerUserZ/OpenTokenUsage)
  — documented the MiniMax `token_plan/remains` response quirks and the
  Kimi Code usage endpoint.
- [schemastery](https://github.com/shigma/schemastery) and
  [cosmokit](https://github.com/cosmokit/cosmokit) (both MIT) — the schema
  library vendored under `src/vendor/`.

## Changelog

- **v0.7.0** — adopted the org TypeScript tool-bundle template (dsh-plugin-check
  compliant, zero waivers): sources moved to `src/*.ts` compiled into `lib/`
  by `npm run build` (tsc + vendored runtime copy), committed artifacts
  verified current by CI; new `dsh-plugin-check` CI gate (any error or warning
  fails — currently verdict=pass, 0 error / 0 warning); CI check job now
  installs dev dependencies and builds before testing.
- **v0.6.0** — coding-plan support: new catalog rows 智谱 GLM Coding
  (`ZAI_CODING_CN_API_KEY`), Z.AI GLM Coding (`ZAI_API_KEY`), Kimi Coding
  (`KIMI_API_KEY`), MiniMax Coding global/CN (`MINIMAX_API_KEY` /
  `MINIMAX_CN_API_KEY`); new `zai-coding-quota` (5h/weekly token windows +
  search lane) and `kimi-coding-usage` (5h + weekly request pool)
  adapters; `minimax-remains` rewritten for the real `model_remains`
  response (now a usage row); `zhipu-quota` shows `percentage` when a
  limit carries no `remaining`; usage rows render missing windows as
  `—` (labels from `windowLabels`, no longer hardcoded rolling/weekly/
  monthly).
- **v0.5.0** — built-in provider catalog + auto discovery (probes
  credential refs; 9 providers on board with zero config); 8 new format
  adapters (incl. one-api/new-api `openai-billing`); `fetch-all`
  contract switched to host-side normalized views (balance / usage / info),
  upstream JSON no longer shipped; per-row HTTP(S) proxy (CONNECT tunnel /
  absolute URI, zero-dependency), **configured in the ⚙ settings panel**
  (localStorage, takes precedence over profile `proxies` / `proxy`);
  new `auto` / `hide` / `proxies` / `catalog` config keys.
- **v0.4.0** — dual-face refactor: host half moved to a loopback Connection
  RPC channel (`specs` / `fetch-all`) + `Config` schema; browser half
  moved into the `dsh.client` manifest + `shell.overlay` slot (React);
  added the ⚙ settings panel (visibility / refresh interval / thresholds,
  localStorage-persisted).
- **v0.3.0** — two sizes: collapsed minimal capsule (independent status
  dot + battery-style value per account), click to expand the full card.
- **v0.2.0** — Harness-native card: design tokens, balance tier
  thresholds, usage progress bar.
- **v0.1.0** — initial floating panel: server-side quota proxy + page badge.

## Security

- API keys are resolved host-side via `ctx.credentials` and used only for
  host-side requests to providers; the browser talks exclusively over the
  loopback RPC channel `/dsh-quota-panel`, the `specs` endpoint ships
  render hints only (labels/kinds/thresholds) with no credential or
  endpoint; since v0.5 `fetch-all` ships normalized views only — raw
  upstream JSON stays host-side too.
- The card builds DOM exclusively with `createElement`/`textContent`;
  API values never touch `innerHTML`; technical errors (401, timeout,
  missing credential, refused proxy) surface only in `title` tooltips or
  inline row text, and one failing row never affects the others.

## TODO

- **Usage-only providers** (OpenAI / Anthropic / Together / Groq / Mistral /
  Cohere / DashScope / Baichuan) as a separate usage row kind showing
  monthly spend instead of balance (Anthropic Admin API and OpenAI usage
  API first).
- socks5 proxy support (HTTP/HTTPS only today).

## Local development

```sh
# Sources live in src/*.ts (org tool-bundle template): tsc compiles them
# into lib/ (declarations included) and scripts/build.mjs copies the
# vendored schema runtime into lib/vendor/. devDependencies are build-only
# — runtime stays zero-dependency.
npm install
npm run build

# After editing src/, rebuild and COMMIT lib/ — github: installs run from
# the committed artifacts (CI's "Committed artifacts are current" step
# rejects a stale lib/).

# Dual-face check: host RPC contract + catalog discovery/proxy engine
# (exercised against real local servers) + client slot/settings surfaces
node scripts/test-page-script.mjs

# Health check with @deepseek-ai/dsh-plugin-check (same gate as CI; fails
# on any error or warning). One-off deps dir, then the gate script:
mkdir -p /tmp/pc-deps && cd /tmp/pc-deps && npm init -y >/dev/null
npm install --no-audit --no-fund --ignore-scripts \
  github:omdsh-dev/dsh-plugin-check \
  @deepseek-ai/dsh-tools @deepseek-ai/dsh-invariants @deepseek-ai/cordis
cd /path/to/dsh-quota-panel
PLUGIN_CHECK_DEPS=/tmp/pc-deps node scripts/plugin-check.mjs .

# To upgrade the vendored schema library: replace the two runtime files
# under src/vendor/ and rewrite the cosmokit import on line 1 of
# schemastery.mjs to "./cosmokit.js", then rebuild.
```

## License

MIT
