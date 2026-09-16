import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const FINITE = value => typeof value === 'number' && Number.isFinite(value)
const COMMON_FIELDS = new Set(['id', 'label', 'kind', 'proxy'])
const BALANCE_FIELDS = new Set([...COMMON_FIELDS, 'currency', 'balanceTiers'])
const USAGE_FIELDS = new Set([...COMMON_FIELDS, 'windowLabels', 'warnPercent', 'errorPercent'])
const INFO_FIELDS = COMMON_FIELDS
const SENSITIVE_KEYS = new Set([
  'credential',
  'credentials',
  'secret',
  'secretcredential',
  'secretkey',
  'clientsecret',
  'apikey',
  'endpoint',
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'bearertoken',
  'password',
  'privatekey',
  'cookie',
  'sessioncookie',
])

function fail(message) {
  throw new TypeError(message)
}

function normalizedKey(key) {
  return key.replace(/[\s_.-]+/g, '').toLowerCase()
}

function hasSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(normalizedKey(key)) || hasSensitiveKey(child)) return true
  }
  return false
}

function requireString(value, message) {
  if (typeof value !== 'string') fail(message)
}

function requireFinite(value, message) {
  if (!FINITE(value)) fail(message)
}

function validateBalance(row) {
  requireString(row.currency, '$.result.value.rows[*].currency must be a string')
  if (!OBJECT(row.balanceTiers)) fail('$.result.value.rows[*].balanceTiers must be an object')
  const keys = Object.keys(row.balanceTiers)
  if (keys.some(key => !['critical', 'warn', 'healthy'].includes(key))) {
    fail('$.result.value.rows[*].balanceTiers must contain only allowed fields')
  }
  if (!['critical', 'warn', 'healthy'].every(key => FINITE(row.balanceTiers[key]))) {
    fail('$.result.value.rows[*].balanceTiers values must be finite numbers')
  }
}

function validateUsage(row) {
  if (!OBJECT(row.windowLabels)) fail('$.result.value.rows[*].windowLabels must be an object')
  if (!Object.values(row.windowLabels).every(value => typeof value === 'string')) {
    fail('$.result.value.rows[*].windowLabels values must be strings')
  }
  requireFinite(row.warnPercent, '$.result.value.rows[*].warnPercent must be a finite number')
  requireFinite(row.errorPercent, '$.result.value.rows[*].errorPercent must be a finite number')
}

function validateRow(row) {
  if (!OBJECT(row)) fail('$.result.value.rows[*] must be an object')

  const allowed = row.kind === 'balance'
    ? BALANCE_FIELDS
    : row.kind === 'usage'
      ? USAGE_FIELDS
      : row.kind === 'info'
        ? INFO_FIELDS
        : null
  if (allowed === null) fail('$.result.value.rows[*].kind must be "balance", "usage", or "info"')
  if (Object.keys(row).some(key => !allowed.has(key))) {
    fail('$.result.value.rows[*] must contain only allowed fields')
  }

  requireString(row.id, '$.result.value.rows[*].id must be a string')
  requireString(row.label, '$.result.value.rows[*].label must be a string')
  if (row.proxy !== null) requireString(row.proxy, '$.result.value.rows[*].proxy must be a string or null')
  if (row.kind === 'balance') validateBalance(row)
  if (row.kind === 'usage') validateUsage(row)
}

export async function dynamicContract(pluginDir) {
  let plugin
  try {
    plugin = await import(pathToFileURL(resolve(pluginDir, 'lib/index.js')).href)
  } catch {
    fail('plugin.lib/index.js must be importable')
  }
  if (typeof plugin.rpcRoutePath !== 'function') fail('plugin.rpcRoutePath must be a function')
  if (typeof plugin.rpcMethod !== 'function') fail('plugin.rpcMethod must be a function')
  if (!Array.isArray(plugin.RPC_ENDPOINTS)) fail('plugin.RPC_ENDPOINTS must be an array')
  if (!plugin.RPC_ENDPOINTS.every(endpoint => typeof endpoint === 'string')) {
    fail('plugin.RPC_ENDPOINTS must contain only strings')
  }
  if (!plugin.RPC_ENDPOINTS.includes('specs')) fail('plugin.RPC_ENDPOINTS must include specs')

  let route
  let method
  try {
    route = plugin.rpcRoutePath('specs')
    method = plugin.rpcMethod('specs')
  } catch {
    fail('plugin specs route and method must be callable')
  }
  if (typeof route !== 'string') fail('plugin specs route must be a string')
  if (typeof method !== 'string') fail('plugin specs method must be a string')
  return { route, method, endpoints: [...plugin.RPC_ENDPOINTS] }
}

export function validateSpecsResponse(text, { rpcId, refreshMs }) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    fail('$ must be valid JSON text')
  }
  if (!OBJECT(body)) fail('$ must be an object')
  if (hasSensitiveKey(body)) fail('$ must not contain sensitive keys')
  if (body.type !== 'server-response') fail('$.type must be "server-response"')
  if (body.rpcId !== rpcId) fail('$.rpcId must match the expected rpcId')
  if (!OBJECT(body.result)) fail('$.result must be an object')
  if (body.result.ok !== true) fail('$.result.ok must be true')
  if (!OBJECT(body.result.value)) fail('$.result.value must be an object')
  if (!Array.isArray(body.result.value.rows)) fail('$.result.value.rows must be an array')
  if (body.result.value.refreshMs !== refreshMs) {
    fail('$.result.value.refreshMs must match the expected refreshMs')
  }
  for (const row of body.result.value.rows) validateRow(row)
  return { rows: body.result.value.rows, refreshMs: body.result.value.refreshMs }
}

export function clientUrlFromBootHtml(html) {
  requireString(html, 'boot HTML must be a string')
  for (const objectText of html.match(/\{[^{}]*\}/g) ?? []) {
    if (!/["']id["']\s*:\s*["']dsh-quota-panel["']/.test(objectText)) continue
    const match = /["']url["']\s*:\s*["']([^"']+)["']/.exec(objectText)
    if (!match) continue
    const url = match[1].replace(/&amp;/gi, '&')
    if (/^\/plugins\/.*client\.js(?:[?&]|$)/.test(url) && /[?&]rev=[^&#]+/.test(url)) return url
  }
  fail('boot HTML must advertise a revisioned dsh-quota-panel client URL')
}

export function redactLog(text) {
  requireString(text, 'log text must be a string')
  return text.replace(/\b(token)(\s*=\s*)[^\s&]+/gi, '$1$2[REDACTED]')
}
