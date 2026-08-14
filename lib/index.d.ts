/**
 * dsh-quota-panel — provider quota card for the dsh web surface.
 *
 * Dual-face plugin: this host half owns the loopback Connection RPC channel
 * `/dsh-quota-panel` (endpoints `specs` / `fetch-all`); the browser half in
 * `lib/client.js` renders the overlay widget through the `dsh.client`
 * manifest. API keys are resolved host-side and never reach the browser.
 */
export const name: 'quota-panel'
export const inject: ['connection', 'credentials']

/** Loopback-only Connection RPC channel this plugin owns. */
export const RPC_CHANNEL: '/dsh-quota-panel'

export interface WindowLabels {
  rolling?: string
  weekly?: string
  monthly?: string
}

export interface BalanceTiers {
  /** total <= critical renders "建议充值" (error/red) */
  critical?: number
  /** total <= warn renders "余额紧张" (warn/amber) */
  warn?: number
  /** total <= healthy renders "余额正常", above renders "余额充足" */
  healthy?: number
}

export interface ProviderConfig {
  /** Row key (RPC rows are keyed by id); ^[a-z0-9-]+$, unique */
  id: string
  /** Provider name shown on the card, e.g. "DeepSeek" */
  label: string
  /** Credential reference, e.g. "DEEPSEEK_API_KEY" */
  credential: string
  /** Quota/balance JSON endpoint to fetch host-side (GET, Bearer auth) */
  endpoint: string
  /** Row renderer: "deepseek-balance" | "opencode-usage" */
  format?: 'deepseek-balance' | 'opencode-usage'
  /** (deepseek-balance) balance level thresholds, defaults {10, 20, 50} */
  balanceTiers?: BalanceTiers
  /** Legacy alias for balanceTiers.warn */
  lowBalance?: number
  /** (opencode-usage) labels for the three windows */
  windowLabels?: WindowLabels
  /** (opencode-usage) warn color threshold, default 70 */
  warnPercent?: number
  /** (opencode-usage) error color threshold, default 90 */
  errorPercent?: number
}

export interface Config {
  /** Default auto-refresh interval in ms, default 60000 (>= 5000) */
  refreshMs?: number
  providers: ProviderConfig[]
}

/** Row spec sent to the client half by the `specs` endpoint. */
export interface RowSpec {
  id: string
  label: string
  format: 'deepseek-balance' | 'opencode-usage'
  windowLabels: Required<WindowLabels>
  warnPercent: number
  errorPercent: number
  balanceTiers: Required<BalanceTiers>
}

/** One provider row returned by the `fetch-all` endpoint. */
export interface FetchRow {
  id: string
  /** Upstream JSON body passthrough */
  data?: unknown
  /** Per-row failure (missing credential, HTTP error, timeout, ...) */
  error?: string
}

export function apply(ctx: any, config?: Config): void
