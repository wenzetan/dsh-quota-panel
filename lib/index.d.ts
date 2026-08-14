/**
 * dsh-quota-panel — provider quota card for the dsh web surface.
 */
export const name: 'quota-panel'
export const inject: ['webServer', 'credentials']

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
  /** Route id, also the row key (`/api/quota/<id>`); ^[a-z0-9-]+$ */
  id: string
  /** Provider name shown on the card, e.g. "DeepSeek" */
  label: string
  /** Credential reference, e.g. "DEEPSEEK_API_KEY" */
  credential: string
  /** Quota/balance JSON endpoint to proxy (GET, Bearer auth) */
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
  /** Auto-refresh interval in ms, default 60000 */
  refreshMs?: number
  providers: ProviderConfig[]
}

export function apply(ctx: any, config?: Config): void
