// Emit bundle names only; never echo manifest contents or parser exceptions.
import { readFileSync } from 'node:fs'

function fail(message) {
  console.error(`[preserve-seed] ${message}`)
  process.exit(1)
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
let text
try { text = readFileSync(process.argv[2], 'utf8') }
catch { fail('manifest missing or unreadable') }
let pkg
try { pkg = JSON.parse(text) }
catch { fail('manifest JSON invalid') }
if (!object(pkg)) fail('manifest must be an object')
if (pkg.dsh !== undefined && !object(pkg.dsh)) fail('dsh must be an object')
if (pkg.dsh?.profile !== undefined && !object(pkg.dsh.profile)) fail('profile must be an object')
const rows = pkg.dsh?.profile?.bundles === undefined ? [] : pkg.dsh.profile.bundles
if (!Array.isArray(rows)) fail('bundles must be an array')
// Names, not version specs, URLs, paths or CLI options. Validate all rows before
// emitting any, so malformed input cannot produce a partial restore list.
const name = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
if (rows.some(row => typeof row !== 'string' || !name.test(row))) {
  fail('bundles entries must be package names')
}
const excluded = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-quota-panel'])
for (const row of rows) if (!excluded.has(row)) console.log(row)
