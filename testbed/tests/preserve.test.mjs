import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const probe = join(root, 'probes/preserve-seed.mjs')
const entrypoint = process.env.ENTRYPOINT_UNDER_TEST || join(root, 'entrypoint.sh')
function fixture(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'preserve-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const manifest = join(dir, 'manifest.json')
  if (content !== undefined) writeFileSync(manifest, content)
  return { dir, manifest }
}
const manifest = (bundles) => JSON.stringify({ dsh: { profile: { bundles } } })
function seed(path) { return spawnSync(process.execPath, [probe, path], { encoding: 'utf8' }) }

test('seed filters base/web-app/self and preserves third-party order', t => {
  const f = fixture(t, manifest(['@deepseek-ai/dsh-base', 'superpowers-dsh', 'dsh-quota-panel', '@deepseek-ai/dsh-web-app', '@example/other']))
  const result = seed(f.manifest)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'superpowers-dsh\n@example/other\n')
})
for (const value of [{}, { dsh: {} }, { dsh: { profile: {} } }, { dsh: { profile: { bundles: [] } } }]) {
  test(`seed accepts absent optional bundles: ${JSON.stringify(value)}`, t => {
    const result = seed(fixture(t, JSON.stringify(value)).manifest)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
  })
}
for (const [name, content, diagnostic] of [
  ['malformed JSON', '{"secret":"DO_NOT_ECHO",', 'JSON'],
  ['non-array bundles', manifest('DO_NOT_ECHO'), 'bundles'],
  ['null bundles', manifest(null), 'bundles'],
  ['non-string row', manifest(['good-package', { secret: 'DO_NOT_ECHO' }]), 'bundles'],
  ['newline row', manifest(['good-package', 'DO_NOT_ECHO\nevil']), 'bundles'],
  ['non-name row', manifest(['https://DO_NOT_ECHO']), 'bundles'],
  ['non-object manifest', '[]', 'manifest'],
  ['non-object profile', '{"dsh":{"profile":false}}', 'profile'],
  ['missing manifest', undefined, 'manifest'],
]) {
  test(`seed rejects ${name} without leaking content or partial rows`, t => {
    const result = seed(fixture(t, content).manifest)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp(diagnostic))
    assert.doesNotMatch(result.stderr, /DO_NOT_ECHO|good-package/)
  })
}

// Only the network/package-manager boundary is replaced: exercise the real
// build_profile, parser and manifest registration, recording requested order.
function build(t, content, failRow = '') {
  const f = fixture(t, content)
  const state = join(f.dir, 'state')
  mkdirSync(join(state, 'profiles/web'), { recursive: true })
  writeFileSync(join(state, 'profiles/web/package.json'), manifest(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']))
  const script = `
    source "$ENTRYPOINT_UNDER_TEST"
    STATE="$TEST_STATE"
    TARBALL=/test/self.tgz
    dsh() {
      printf '%s\\n' "$5" >> "$TEST_TRACE"
      [ "$5" != "$TEST_FAIL_ROW" ] || return 42
    }
    build_profile
  `
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
    ...process.env, DSH_VERSION: 'test', STEPS: 'none', PROFILE_MODE: 'preserve',
    ENTRYPOINT_UNDER_TEST: resolve(entrypoint), HOST_PROFILE_MANIFEST: f.manifest,
    TEST_STATE: state, TEST_TRACE: join(f.dir, 'trace'), TEST_FAIL_ROW: failRow,
  } })
  const read = path => { try { return readFileSync(path, 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } }
  return { ...result, trace: read(join(f.dir, 'trace')), unrestored: read(join(state, 'preserve-unrestored.txt')), pkg: JSON.parse(read(join(state, 'profiles/web/package.json'))) }
}
test('preserve restores names in order, installs self last and registers self', t => {
  const result = build(t, manifest(['@deepseek-ai/dsh-base', 'one', 'dsh-quota-panel', 'two']))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.trace, 'one\ntwo\n/test/self.tgz\n')
  assert.deepEqual(result.pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-quota-panel'])
  assert.equal(result.unrestored, '')
})
test('preserve warns and records failed third-party rows, then installs self', t => {
  const result = build(t, manifest(['one', 'two']), 'one')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.trace, 'one\ntwo\n/test/self.tgz\n')
  assert.equal(result.unrestored, 'one\n')
  assert.match(result.stdout, /未恢复.*one/)
  assert.match(result.stdout, /rc=42/)
})
test('preserve fails closed before any install when seed is invalid', t => {
  const result = build(t, manifest({ secret: 'DO_NOT_ECHO' }))
  assert.equal(result.status, 1)
  assert.equal(result.trace, '')
  assert.match(result.stdout + result.stderr, /bundles/)
  assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_ECHO/)
})
test('preserve self install failure is fatal and does not register self', t => {
  const result = build(t, manifest(['one']), '/test/self.tgz')
  assert.equal(result.status, 1)
  assert.equal(result.trace, 'one\n/test/self.tgz\n')
  assert.ok(!result.pkg.dsh.profile.bundles.includes('dsh-quota-panel'))
})
