/**
 * dsh-quota-panel — provider quota card for the dsh web surface.
 *
 * Dual-face plugin: this host half owns the loopback Connection RPC channel
 * `/dsh-quota-panel` (endpoints `specs` / `fetch-all`); the browser half in
 * `lib/client.js` renders the overlay widget through the `dsh.client`
 * manifest. API keys are resolved host-side and never reach the browser.
 * `fetch-all` rows carry host-normalized view models; upstream response
 * schemas stay host-side.
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
  /** amount <= critical renders "建议充值" (error/red) */
  critical?: number
  /** amount <= warn renders "余额紧张" (warn/amber) */
  warn?: number
  /** amount <= healthy renders "余额正常", above renders "余额充足" */
  healthy?: number
}

/** Row adapter ids; each maps to one upstream API family. */
export type ProviderFormat =
  | 'deepseek-balance'
  | 'openrouter-credits'
  | 'siliconflow-balance'
  | 'moonshot-balance'
  | 'minimax-remains'
  | 'stepfun-accounts'
  | 'xai-credits'
  | 'openai-billing'
  | 'zhipu-quota'
  | 'opencode-usage'

/** Partial overrides applied to a built-in catalog entry. */
export interface CatalogOverride {
  label?: string
  endpoint?: string
  format?: ProviderFormat
  /** must name a key of Config.proxies */
  proxy?: string
  /** credential references to probe, UPPER_SNAKE_CASE */
  refs?: string[]
  balanceTiers?: BalanceTiers
  warnPercent?: number
  errorPercent?: number
  windowLabels?: WindowLabels
}

export interface ProviderConfig {
  /** Row key (RPC rows are keyed by id); ^[a-z0-9-]+$, unique */
  id: string
  /** Provider name shown on the card, e.g. "DeepSeek" */
  label: string
  /** Credential reference, e.g. "DEEPSEEK_API_KEY" */
  credential: string
  /**
   * Quota/balance JSON endpoint to fetch host-side (GET, Bearer auth);
   * for format "openai-billing" this is the aggregator base URL
   */
  endpoint: string
  format?: ProviderFormat
  /** name of an entry in Config.proxies; omit for direct connection */
  proxy?: string
  /** (balance kinds) balance level thresholds, defaults {10, 20, 50} */
  balanceTiers?: BalanceTiers
  /** Legacy alias for balanceTiers.warn */
  lowBalance?: number
  /** (opencode-usage) labels for the three windows */
  windowLabels?: WindowLabels
  /** (usage kinds) warn color threshold, default 70 */
  warnPercent?: number
  /** (usage kinds) error color threshold, default 90 */
  errorPercent?: number
}

export interface Config {
  /** Default auto-refresh interval in ms, default 60000 (>= 5000) */
  refreshMs?: number
  /** Probe the built-in catalog for configured credential references, default true */
  auto?: boolean
  /** Row ids to drop from the panel (catalog and explicit alike) */
  hide?: string[]
  /** Proxy definitions; HTTP(S) proxies only (CONNECT tunnel / absolute URI) */
  proxies?: Record<string, string>
  /** Partial overrides applied to auto-discovered catalog rows */
  catalog?: Record<string, CatalogOverride>
  providers: ProviderConfig[]
}

/** Row spec sent to the client half by the `specs` endpoint. */
export interface RowSpec {
  id: string
  label: string
  kind: 'balance' | 'usage' | 'info'
  /** (balance) currency symbol rendered before the amount */
  currency?: '¥' | '$'
  balanceTiers?: Required<BalanceTiers>
  windowLabels?: Required<WindowLabels>
  warnPercent?: number
  errorPercent?: number
}

/** Host-normalized view carried by `fetch-all` rows on success. */
export type RowView =
  | { kind: 'balance'; amount: number; title?: string }
  | { kind: 'usage'; windows: { rolling: WindowValue; weekly: WindowValue; monthly: WindowValue } }
  | { kind: 'info'; text: string; title?: string }

export interface WindowValue {
  percent: number
  resetsAt?: string
}

/** One provider row returned by the `fetch-all` endpoint. */
export interface FetchRow {
  id: string
  /** Normalized view on success */
  view?: RowView
  /** Per-row failure (missing credential, HTTP error, timeout, ...) */
  error?: string
}

export function apply(ctx: any, config?: Config): void
