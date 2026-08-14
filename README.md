# dsh-quota-panel

Provider quota / balance corner panel for the **dsh web surface** (DeepSeek Harness).

A zero-dependency host plugin: for every configured provider it registers one
server-side proxy route `/api/quota/<id>` — the API key is resolved through the
credentials seam and **never reaches the browser** — then injects a small
bottom-right panel into the served page that fetches the routes and renders one
row per provider. Rows auto-refresh every 60s and on click; hover shows detail
(windows, resets, granted vs topped-up), and colors flag low balance or high
usage.

## Install

```sh
dsh plugin --profile web add "github:OWNER/dsh-quota-panel"
# restart `dsh web` (bundle layers apply at boot)
```

The package declares `dsh.bundle.patch`, so `dsh plugin add` activates it as a
profile layer automatically.

## Configuration

Each provider is one entry under `providers`. Two renderers ship:

| format | endpoint shape | row |
|---|---|---|
| `deepseek-balance` | `{ "balance_infos": [{ "currency", "total_balance", "granted_balance", "topped_up_balance" }] }` | `¥15.63`, warns below `lowBalance` |
| `opencode-usage` | `{ "usage": { "rolling"|"weekly"|"monthly": { "percent", "resetsAt" } } }` | `滚 4% · 周 43% · 月 21%`, warns at `warnPercent`, errors at `errorPercent` |

Override the shipped defaults in your profile's `cordis.patch.yml`:

```yaml
- id: quota-panel
  config:
    refreshMs: 30000
    providers:
      - id: deepseek
        label: DS 余额
        credential: DEEPSEEK_API_KEY
        endpoint: https://api.deepseek.com/user/balance
        format: deepseek-balance
        lowBalance: 5
      - id: opencode-go
        label: OC Go
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
| `id` | route id (`/api/quota/<id>`), `^[a-z0-9-]+$` | required |
| `label` | row label | required |
| `credential` | credential reference (`$DSH_HOME/.credentials.yaml` or env) | required |
| `endpoint` | quota JSON endpoint, GET with `Authorization: Bearer <key>` | required |
| `format` | row renderer | `deepseek-balance` |
| `windowLabels` | (opencode-usage) `{rolling, weekly, monthly}` | `{滚, 周, 月}` |
| `warnPercent` / `errorPercent` | (opencode-usage) color thresholds | 70 / 90 |
| `lowBalance` | (deepseek-balance) warn-below total | 5 |
| `refreshMs` | panel auto-refresh interval | 60000 |

## Security

- API keys are resolved server-side via `ctx.credentials` and only used in the
  server-to-provider request; the browser only talks to `/api/quota/<id>`.
- The injected panel script contains no key material and no HTML (text nodes
  only), and row values come from the same JSON escaping path.

## License

MIT
