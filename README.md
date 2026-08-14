# dsh-quota-panel

English | [中文](README.zh.md)

Provider quota / balance status widget for the **dsh web surface** (DeepSeek
Harness).

As of v0.4 this is a **dual-face plugin**:

- **Host half** (`lib/index.js`): registers one loopback-only Connection RPC
  channel `/dsh-quota-panel` (endpoints `specs` / `fetch-all`). API keys are
  resolved through `ctx.credentials` and **never reach the browser**; upstream
  quota endpoints are proxied host-side with `Authorization: Bearer <key>`,
  with per-row error capture.
- **Client half** (`lib/client.js`, served at `/plugins/dsh-quota-panel/client.js`
  via the `dsh.client` manifest): registers a `shell.overlay` slot entry that
  renders the bottom-right Harness-native widget with React, in two sizes:

- **Collapsed (default)** — a minimal glanceable capsule: one independent
  "status dot + value" pair per account (e.g. `● ¥58.36 · ● 45%`), no text
  labels — only the affected account's dot changes color. Click to expand.
- **Expanded** — the full card: "模型额度" header with refresh / **⚙ settings**
  / collapse buttons, then one structured row per provider (status dot, name,
  primary value, secondary line, progress bar for usage-style providers). The
  collapse button shrinks it back.

Both sizes auto-refresh (paused while the page is hidden; the refresh button
spins while a manual refresh runs and re-entrant clicks are ignored).

### Settings panel (⚙)

Next to the refresh button in the expanded card, the gear button opens three
groups of local settings — applied immediately, persisted to browser
localStorage, never written to the profile or sent anywhere:

- **Provider visibility** — one checkbox per provider (hiding all shows
  "已全部隐藏" in the capsule but keeps the settings entry reachable);
- **Refresh interval** — follow config (default) or 15s ~ 5min fixed;
- **Warn thresholds** — per provider override: balance rows take a ¥ warn value
  (critical auto-derives as value/2), usage rows take a warn % (error auto-
  derives as max(config, warn+1)); empty restores the config default;
- **Reset** — one click clears every local override.

In the capsule, usage percentages are battery-colored (green when healthy,
amber when tight, red when critical), matching their independent dot; balance
values are tinted only when their own state warns or errors.

The widget is styled with the Harness design tokens (`--dsw-alias-*`,
`--dsw-static-*`, `--dsw-shadow-*`, `--dsw-font-*`) and falls back to sensible
values when tokens are absent, so it follows the product theme (light/dark)
instead of carrying its own palette.

> Screenshots below were taken at v0.3 (no ⚙ entry yet); the capsule/card
> styling is unchanged.

## Screenshots

Collapsed capsule (light / dark):

![Capsule (light)](docs/capsule-light.png)
![Capsule (dark)](docs/capsule-dark.png)

Expanded card (light / dark):

![Panel (light)](docs/panel-light.png)
![Panel (dark)](docs/panel-dark.png)

Full page, collapsed capsule (light / dark):

![Full page, capsule (light)](docs/screenshot-light.png)
![Full page, capsule (dark)](docs/screenshot-dark.png)

## Install

```sh
# Track main (resolves to the latest commit on install)
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel"
# Or pin to an auto-tagged release (see .github/workflows/tag-release.yml)
dsh plugin --profile web add "github:wenzetan/dsh-quota-panel#v0.4.0"
# restart `dsh web` (bundle layers and the client module graph apply at boot)
```

Refresh the browser page once after installing. Zero npm dependencies (the
schema library is vendored), so no `allowBuilds` authorization is needed.

The package declares `dsh.bundle.patch` (host half activates as a profile
layer automatically) and a `dsh.client` manifest (client half enters the
`__DSH_BOOT__` module graph, prefetched with `immediately: true`).

From a local checkout (development):

```sh
dsh plugin --profile web add "link:/path/to/dsh-quota-panel"
# or point the profile package.json dependency at link: and pnpm install
```

> The package has **zero npm dependencies**: the schema library (schemastery +
> cosmokit, both MIT) is vendored under `lib/vendor/` and imported by relative
> path, so a `link:` install needs **no** repo `node_modules` — Node resolves
> from the repo's real path and cannot walk up to dsh's bundled packages,
> which is exactly why the vendor exists.

## Configuration

Structure and defaults are declared by the exported **`Config` schema**
(vendored schemastery), so profile patches may omit every defaulted
field; cross-field semantics (unique ids, `critical <= warn <= healthy`) are
validated by the host half at mount time.

Each provider is one entry under `providers`. Two renderers ship:

| format | endpoint shape | row |
|---|---|---|
| `deepseek-balance` | `{ "balance_infos": [{ "currency", "total_balance", "granted_balance", "topped_up_balance" }] }` | `¥58.36` + 余额充足/正常/紧张/建议充值 |
| `opencode-usage` | `{ "usage": { "rolling"\|"weekly"\|"monthly": { "percent", "resetsAt" } } }` | `五 10% · 周 45% · 月 22%` + progress bar + 当前最高占用 |

Override the shipped defaults in your profile's `cordis.patch.yml`:

```yaml
- id: quota-panel
  config:
    refreshMs: 30000
    providers:
      - id: deepseek
        label: DeepSeek
        credential: DEEPSEEK_API_KEY
        endpoint: https://api.deepseek.com/user/balance
        format: deepseek-balance
        balanceTiers: { critical: 10, warn: 20, healthy: 50 }
      - id: opencode-go
        label: OpenCode Go
        credential: OPENCODE_GO_API_KEY
        endpoint: https://opencode.ai/zen/go/v1/usage
        format: opencode-usage
        windowLabels: { rolling: 五, weekly: 周, monthly: 月 }
        warnPercent: 70
        errorPercent: 90
```

Fields:

| field | meaning | default |
|---|---|---|
| `id` | row key (RPC rows align by id), `^[a-z0-9-]+$` | required |
| `label` | provider name on the card | required |
| `credential` | credential reference (`$DSH_HOME/.credentials.yaml` or env) | required |
| `endpoint` | quota JSON endpoint, GET with `Authorization: Bearer <key>` | required |
| `format` | row renderer | `deepseek-balance` |
| `balanceTiers` | (deepseek-balance) `{critical, warn, healthy}` levels | `{10, 20, 50}` |
| `lowBalance` | legacy alias for `balanceTiers.warn` | — |
| `windowLabels` | (opencode-usage) `{rolling, weekly, monthly}` | `{滚, 周, 月}` |
| `warnPercent` / `errorPercent` | (opencode-usage) thresholds | 70 / 90 |
| `refreshMs` | auto-refresh interval | 60000 |

### DeepSeek balance levels

With the default `balanceTiers {critical: 10, warn: 20, healthy: 50}`:

| balance | state | secondary line |
|---|---|---|
| `<= 10` | error (red dot + value) | 建议充值 |
| `10 < x <= 20` | warn (amber) | 余额紧张 |
| `20 < x <= 50` | ok | 余额正常 |
| `> 50` | ok | 余额充足 |

### OpenCode usage states

`high = max(rolling, weekly, monthly)`:

| usage | state |
|---|---|
| `< warnPercent` | ok (green dot, DeepSeek-blue progress) |
| `>= warnPercent` | warn (amber dot + progress) |
| `>= errorPercent` | error (red dot + progress) |

## Changelog

- **v0.4.0** — Dual-face refactor: host half becomes a loopback Connection RPC
  channel (`specs` / `fetch-all`) + `Config` schema; client half moves into the
  `dsh.client` manifest + `shell.overlay` slot (React); adds the ⚙ settings
  panel (provider visibility / refresh interval / warn thresholds, persisted to
  localStorage).
- **v0.3.0** — Two sizes: collapsed capsule (independent per-account dot +
  battery-colored value) expands into the full card.
- **v0.2.0** — Harness-native card: design tokens, balance tiers, progress bar.
- **v0.1.0** — Initial floating panel: server-side quota proxies + page badge.

## Security

- API keys are resolved host-side via `ctx.credentials` and only used in the
  host-to-provider request; the browser only talks to the loopback RPC channel
  `/dsh-quota-panel`, and the `specs` endpoint ships render hints only (labels,
  formats, thresholds) — no credential, no endpoint.
- The card builds DOM with `createElement`/`textContent` only; API response
  values never pass through `innerHTML`. Technical errors (401, timeout,
  credential missing) go into `title` hover text or an inline row error; one
  failing row never breaks the others.

## Local development

```sh
# Zero dependencies — no npm install needed. To upgrade the vendor, replace
# the two files under lib/vendor/ and rewrite schemastery.mjs's first-line
# cosmokit import to "./cosmokit.js".
# Dual-face checks: host RPC contract + client slot registration / settings surface
node scripts/test-page-script.mjs
```

## License

MIT
