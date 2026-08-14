/**
 * dsh-quota-panel — quota/balance corner panel for the dsh web surface.
 */
export const name: 'quota-panel'
export const inject: ['webServer', 'credentials']

export interface WindowLabels {
  rolling?: string
  weekly?: string
  monthly?: string
}

export interface ProviderConfig {
  /** Route id, also the row key (`/api/quota/<id>`); ^[a-z0-9-]+$ */
  id: string
  /** Text shown before the value, e.g. "DS 余额" */
  label: string
  /** Credential reference, e.g. "DEEPSEEK_API_KEY" */
  credential: string
  /** Quota/balance JSON endpoint to proxy (GET, Bearer auth) */
  endpoint: string
  /** Row renderer: "deepseek-balance" | "opencode-usage" */
  format?: 'deepseek-balance' | 'opencode-usage'
  /** (opencode-usage) labels for the three windows */
  windowLabels?: WindowLabels
  /** (opencode-usage) warn color threshold, default 70 */
  warnPercent?: number
  /** (opencode-usage) error color threshold, default 90 */
  errorPercent?: number
  /** (deepseek-balance) warn below this total, default 5 */
  lowBalance?: number
}

export interface Config {
  /** Auto-refresh interval in ms, default 60000 */
  refreshMs?: number
  providers: ProviderConfig[]
}

export function apply(ctx: any, config?: Config): void
