import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const testbedDir = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(testbedDir, '..')
const probe = join(testbedDir, 'probes/boot-probe.sh')
const realHelper = join(testbedDir, 'probes/rpc-contract.mjs')
const syntheticToken = 'SYNTHETIC_STARTUP_TOKEN'
const syntheticLogToken = 'SYNTHETIC_LOG_TOKEN'
const responseMarker = 'SYNTHETIC_RESPONSE_BODY_MUST_NOT_LEAK'
const advertisedClient = '/plugins/??dsh-quota-panel/client.js&rev=quota-real-42'

function executable(path, content) {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function makeFixture(t, scenario = 'success') {
  const dir = mkdtempSync(join(tmpdir(), 'quota-boot-probe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  const home = join(dir, 'dsh-home')
  mkdirSync(bin)
  mkdirSync(work)
  mkdirSync(home)

  const dshTrace = join(dir, 'dsh.args')
  const curlTrace = join(dir, 'curl.trace')
  const helperTrace = join(dir, 'helper.trace')
  const reaped = join(dir, 'dsh.reaped')
  const boot = join(dir, 'boot.html')
  const specs = join(dir, 'specs.json')
  writeFileSync(boot, '<!doctype html><script>window.__DSH_BOOT__ = {"meta":{"shape":"representative-real-boot"},"plugins":[{"url":"/plugins/??dsh-quota-panel/client.js&amp;rev=quota-real-42","platform":"web","enabled":true,"id":"dsh-quota-panel"}]};</script>\n')
  writeFileSync(specs, scenario === 'bad-specs'
    ? JSON.stringify({ type: 'server-response', rpcId: 'wrong-id', result: { ok: false, error: { message: responseMarker } } })
    : JSON.stringify({ type: 'server-response', rpcId: 'testbed-probe', result: { ok: true, value: { rows: [], refreshMs: 60000 } } }))

  executable(join(bin, 'dsh'), [
    '#!/usr/bin/env bash',
    'set -eu',
    'printf "%s\\n" "$*" > "$STUB_DSH_TRACE"',
    'if [ "${STUB_DSH_TOKEN_MODE:-present}" != missing ]; then',
    '  printf "open http://127.0.0.1:3080/?token=%s\\n" "$STUB_SECRET_TOKEN"',
    'fi',
    'printf "diagnostic token = %s\\n" "$STUB_LOG_TOKEN"',
    "trap 'sleep 0.15; printf \"terminated\\n\" > \"$STUB_DSH_REAPED\"; exit 0' TERM INT HUP",
    'while :; do sleep 0.05; done',
    '',
  ].join('\n'))

  executable(join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'set -u',
    'out=""; cookie_out=""; method=GET; url=""; have_connect=0; have_max=0; follow=0',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --connect-timeout) have_connect=1; connect_value="$2"; shift 2 ;;',
    '    --max-time) have_max=1; max_value="$2"; shift 2 ;;',
    '    --location|-L) follow=1; shift ;;',
    '    -o|--output) out="$2"; shift 2 ;;',
    '    -c|--cookie-jar) cookie_out="$2"; shift 2 ;;',
    '    -b|--cookie|-w|--write-out|-H|--header|-d|--data|--data-raw) shift 2 ;;',
    '    -X|--request) method="$2"; shift 2 ;;',
    '    -*) shift ;;',
    '    *) url="$1"; shift ;;',
    '  esac',
    'done',
    'printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$method" "$url" "${connect_value:-missing}" "${max_value:-missing}" "$follow" >> "$STUB_CURL_TRACE"',
    'if [ "$have_connect" -ne 1 ] || [ "$have_max" -ne 1 ]; then printf 000; exit 90; fi',
    'write_body() { [ -z "$out" ] || printf "%s" "$1" > "$out"; }',
    'if [ "${STUB_CURL_SCENARIO:-success}" = connect-fail ]; then printf 000; exit 7; fi',
    'case "$url" in',
    '  *"?token="*)',
    '    if [ "$follow" -ne 1 ]; then write_body "redirect"; printf 303; exit 0; fi',
    '    if [ "${STUB_CURL_SCENARIO:-success}" != no-cookie ] && [ -n "$cookie_out" ]; then printf "stub-cookie\\n" > "$cookie_out"; fi',
    '    write_body "authenticated"; printf 200; exit 0 ;;',
    '  "http://127.0.0.1:${PORT_UNDER_TEST}/")',
    '    if [ "${STUB_CURL_SCENARIO:-success}" = total-timeout ]; then printf 000; exit 28; fi',
    '    if [ "${STUB_CURL_SCENARIO:-success}" = auth-forbidden ]; then write_body forbidden; printf 403; exit 0; fi',
    '    [ -z "$out" ] || cp "$STUB_BOOT_FILE" "$out"; printf 200; exit 0 ;;',
    '  "http://127.0.0.1:${PORT_UNDER_TEST}/plugins/??dsh-quota-panel/client.js&rev=quota-real-42")',
    '    write_body "export default true"; printf 200; exit 0 ;;',
    '  "http://127.0.0.1:${PORT_UNDER_TEST}/api/dsh-quota-panel/specs")',
    '    if [ "${STUB_CURL_SCENARIO:-success}" = route-missing ]; then write_body "$STUB_RESPONSE_MARKER"; printf 405; exit 0; fi',
    '    [ -z "$out" ] || cp "$STUB_SPECS_FILE" "$out"; printf 200; exit 0 ;;',
    '  *) write_body not-found; printf 404; exit 0 ;;',
    'esac',
    '',
  ].join('\n'))

  const helperWrapper = join(dir, 'contract-helper-stub.mjs')
  writeFileSync(helperWrapper, [
    "import { appendFileSync } from 'node:fs'",
    "import { spawnSync } from 'node:child_process'",
    "appendFileSync(process.env.STUB_HELPER_TRACE, JSON.stringify(process.argv.slice(2)) + '\\n')",
    'const result = spawnSync(process.execPath, [process.env.REAL_CONTRACT_HELPER, ...process.argv.slice(2)], { stdio: \'inherit\' })',
    'process.exit(result.status ?? 1)',
    '',
  ].join('\n'))

  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    DSH_VERSION: 'test-version',
    GRID_LABEL: 'stub-flow',
    DSH_HOME: home,
    PLUGIN_DIR: repoRoot,
    CONTRACT_HELPER: helperWrapper,
    REAL_CONTRACT_HELPER: realHelper,
    STUB_HELPER_TRACE: helperTrace,
    STUB_DSH_TRACE: dshTrace,
    STUB_DSH_REAPED: reaped,
    STUB_DSH_TOKEN_MODE: scenario === 'missing-token' ? 'missing' : 'present',
    STUB_SECRET_TOKEN: syntheticToken,
    STUB_LOG_TOKEN: syntheticLogToken,
    STUB_CURL_TRACE: curlTrace,
    STUB_CURL_SCENARIO: scenario,
    STUB_BOOT_FILE: boot,
    STUB_SPECS_FILE: specs,
    STUB_RESPONSE_MARKER: responseMarker,
    PORT_UNDER_TEST: '31999',
    PORT: '31999',
    WORK_DIR: work,
    LOG: join(work, 'dsh-web.log'),
    COOKIE: join(work, 'cookies.txt'),
    L2_DEADLINE_SECONDS: scenario === 'missing-token' ? '1' : '5',
    L2_POLL_SECONDS: '0.02',
    CURL_CONNECT_TIMEOUT: '1',
    CURL_MAX_TIME: '1',
    FAIL_LOG_LINES: '20',
  }
  return { dir, work, env, dshTrace, curlTrace, helperTrace, reaped }
}

function runProbe(t, scenario = 'success') {
  const fixture = makeFixture(t, scenario)
  const started = Date.now()
  const result = spawnSync('bash', [probe], {
    cwd: repoRoot,
    env: fixture.env,
    encoding: 'utf8',
    timeout: 7000,
  })
  return { ...fixture, ...result, elapsedMs: Date.now() - started, output: `${result.stdout}${result.stderr}` }
}

function readIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function assertStoppedAndReaped(result) {
  assert.equal(result.signal, null, `probe timed out or was signalled: ${result.output}`)
  assert.equal(readIfPresent(result.reaped), 'terminated\n', 'EXIT trap must kill and wait for dsh web cleanup')
}

function helperModes(result) {
  return readIfPresent(result.helperTrace).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)[0])
}

test('rpc-contract CLI exposes only safe contract, client URL, validation summary, and redacted logs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-contract-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const boot = join(dir, 'boot.html')
  const body = join(dir, 'body.json')
  writeFileSync(boot, '<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&amp;rev=cli-1"}]}</script>')
  writeFileSync(body, JSON.stringify({ type: 'server-response', rpcId: 'cli-probe', result: { ok: true, value: { rows: [], refreshMs: 60000 } } }))

  const contract = spawnSync(process.execPath, [realHelper, 'contract', repoRoot], { encoding: 'utf8' })
  assert.equal(contract.status, 0, contract.stderr)
  assert.deepEqual(JSON.parse(contract.stdout), {
    route: '/api/dsh-quota-panel/specs',
    method: 'dsh-quota-panel/specs',
    endpoints: ['specs', 'fetch-all', 'chatgpt-auth-status', 'chatgpt-login-start', 'chatgpt-login-cancel', 'chatgpt-logout'],
  })

  const client = spawnSync(process.execPath, [realHelper, 'client-url', boot], { encoding: 'utf8' })
  assert.equal(client.status, 0, client.stderr)
  assert.equal(client.stdout, '/plugins/??dsh-quota-panel/client.js&rev=cli-1\n')

  const validated = spawnSync(process.execPath, [realHelper, 'validate-specs', body, 'cli-probe', '60000'], { encoding: 'utf8' })
  assert.equal(validated.status, 0, validated.stderr)
  assert.equal(validated.stdout, 'specs rows=0 refreshMs=60000\n')

  const redacted = spawnSync(process.execPath, [realHelper, 'redact-log', '-'], {
    input: `open ?token=${syntheticToken}&next=1 token = ${syntheticLogToken}\n`,
    encoding: 'utf8',
  })
  assert.equal(redacted.status, 0, redacted.stderr)
  assert.equal(redacted.stdout, 'open ?token=[REDACTED]&next=1 token = [REDACTED]\n')
})

test('real shell flow requires --no-open, authenticates, GETs advertised revision, and validates dynamic specs', t => {
  const result = runProbe(t)
  assert.equal(result.status, 0, result.output)
  assert.equal(readFileSync(result.dshTrace, 'utf8'), 'web --no-open\n')
  const calls = readFileSync(result.curlTrace, 'utf8').trim().split('\n').map(line => line.split('\t'))
  assert.ok(calls.length >= 4, result.output)
  assert.ok(calls.every(([, , connect, max]) => connect === '1' && max === '1'), 'every curl call must set connect and total timeouts')
  assert.ok(calls.some(([method, url, , , follow]) => method === 'GET' && url.includes('/?token=') && follow === '1'), 'token exchange must follow the 303 redirect to a final 200 and cookie')
  assert.ok(calls.some(([method, url]) => method === 'GET' && url === `http://127.0.0.1:31999${advertisedClient}`), 'advertised revisioned client URL must be actually fetched')
  assert.ok(calls.some(([method, url]) => method === 'POST' && url === 'http://127.0.0.1:31999/api/dsh-quota-panel/specs'), 'dynamic specs route must be POSTed')
  assert.deepEqual(helperModes(result), ['contract', 'client-url', 'validate-specs'])
  assert.match(result.output, /L2 全部通过/)
  assert.doesNotMatch(result.output, new RegExp(`${syntheticToken}|${syntheticLogToken}`))
  assertStoppedAndReaped(result)
})

test('missing startup token and missing session cookie both fail closed', async t => {
  await t.test('token is mandatory', t => {
    const result = runProbe(t, 'missing-token')
    assert.notEqual(result.status, 0, result.output)
    assert.match(result.output, /token.*未取得|未取得.*token/i)
    assert.doesNotMatch(result.output, new RegExp(`${syntheticToken}|${syntheticLogToken}`))
    assertStoppedAndReaped(result)
  })
  await t.test('cookie is mandatory', t => {
    const result = runProbe(t, 'no-cookie')
    assert.notEqual(result.status, 0, result.output)
    assert.match(result.output, /cookie.*未建立|未建立.*cookie/i)
    assert.doesNotMatch(result.output, new RegExp(`${syntheticToken}|${syntheticLogToken}`))
    assertStoppedAndReaped(result)
  })
})

for (const [scenario, diagnostic] of [
  ['connect-fail', /curl.*7|连接/i],
  ['total-timeout', /curl.*28|超时/i],
]) {
  test(`${scenario} curl failure cannot produce a passing probe`, t => {
    const result = runProbe(t, scenario)
    assert.notEqual(result.status, 0, result.output)
    assert.match(result.output, diagnostic)
    assert.doesNotMatch(result.output, /L2 全部通过/)
    assertStoppedAndReaped(result)
  })
}

test('HTTP 200 with a bad specs envelope fails through the existing contract helper without body echo', t => {
  const result = runProbe(t, 'bad-specs')
  assert.notEqual(result.status, 0, result.output)
  assert.match(result.output, /specs.*契约|契约.*specs/i)
  assert.ok(helperModes(result).includes('validate-specs'), 'the shell must delegate JSON semantics to rpc-contract.mjs')
  assert.doesNotMatch(result.output, new RegExp(responseMarker))
  assertStoppedAndReaped(result)
})

test('missing specs route fails only after auth, home, and revisioned client pass; failure logs redact tokens', t => {
  const result = runProbe(t, 'route-missing')
  assert.notEqual(result.status, 0, result.output)
  const calls = readFileSync(result.curlTrace, 'utf8').trim().split('\n').map(line => line.split('\t'))
  const authIndex = calls.findIndex(([method, url, , , follow]) => method === 'GET' && url.includes('/?token=') && follow === '1')
  const homeIndex = calls.findIndex(([method, url]) => method === 'GET' && url === 'http://127.0.0.1:31999/')
  const clientIndex = calls.findIndex(([method, url]) => method === 'GET' && url === `http://127.0.0.1:31999${advertisedClient}`)
  const specsIndex = calls.findIndex(([method, url]) => method === 'POST' && url === 'http://127.0.0.1:31999/api/dsh-quota-panel/specs')
  assert.ok(authIndex >= 0 && authIndex < homeIndex, 'auth redirect and cookie must complete before the home probe')
  assert.ok(homeIndex < clientIndex && clientIndex < specsIndex, 'home and advertised client must pass before the missing route is exercised')
  assert.match(result.output, /路由缺失.*405|405.*路由缺失/)
  assert.match(result.output, /token=\[REDACTED\]/i)
  assert.doesNotMatch(result.output, new RegExp(`${syntheticToken}|${syntheticLogToken}|${responseMarker}`))
  assert.ok(helperModes(result).includes('redact-log'), 'failure log output must pass through redactLog')
  assertStoppedAndReaped(result)
})
