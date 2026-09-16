import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const testbedDir = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(testbedDir, '..')
const globalCompose = join(testbedDir, 'compose.yaml')
const chinaCompose = join(testbedDir, 'compose.china.yaml')
const runner = join(testbedDir, 'run.mjs')
const dockerfile = join(testbedDir, 'Dockerfile')
const chinaEnvExample = join(testbedDir, '.env.china.example')
const networkSkill = join(repoRoot, '.dsh/skills/dsh-plugin-testbed-network/SKILL.md')

const deterministicEnv = {
  NODE_IMAGE: '',
  NPM_REGISTRY: '',
  APT_MIRROR: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  NO_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  no_proxy: '',
}

function composeConfig(t, files, overrides = {}) {
  const dockerConfig = mkdtempSync(join(tmpdir(), 'quota-compose-config-'))
  t.after(() => rmSync(dockerConfig, { recursive: true, force: true }))
  const args = ['compose']
  for (const file of files) args.push('-f', file)
  args.push('config', '--format', 'json')
  const result = spawnSync('docker', args, {
    cwd: testbedDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...deterministicEnv,
      ...overrides,
      DOCKER_CONFIG: dockerConfig,
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return { config: JSON.parse(result.stdout), text: result.stdout }
}

function serviceOf(config) {
  const service = config.services?.testbed
  assert.ok(service, 'resolved Compose config must contain services.testbed')
  return service
}

test('global Compose resolves only official network defaults', t => {
  const { config, text } = composeConfig(t, [globalCompose])
  const service = serviceOf(config)

  assert.equal(config.name, 'dsh-testbed-quota-panel')
  assert.equal(service.image, 'dsh-testbed-quota-panel:0.1.5-rc.1')
  assert.equal(service.build.args.NODE_IMAGE, 'node:24-bookworm-slim')
  assert.equal(service.build.args.NPM_REGISTRY, 'https://registry.npmjs.org')
  assert.equal(service.build.args.APT_MIRROR, '')
  assert.equal(service.environment.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org')
  assert.doesNotMatch(text, /daocloud|npmmirror|mirrors\.(?:aliyun|tuna|ustc)|\.cn(?:[/:]|$)/i)
})

test('China override resolves mirror defaults and a distinct identity', t => {
  const { config } = composeConfig(t, [globalCompose, chinaCompose])
  const service = serviceOf(config)

  assert.equal(config.name, 'dsh-testbed-quota-panel-china')
  assert.equal(service.image, 'dsh-testbed-quota-panel-china:0.1.5-rc.1')
  assert.equal(service.build.args.NODE_IMAGE, 'docker.m.daocloud.io/library/node:24-bookworm-slim')
  assert.equal(service.build.args.NPM_REGISTRY, 'https://registry.npmmirror.com')
  assert.equal(service.build.args.APT_MIRROR, 'http://mirrors.aliyun.com/debian')
  assert.equal(service.environment.NPM_CONFIG_REGISTRY, 'https://registry.npmmirror.com')
})

test('China override passes configurable apt and proxy values to build and runtime', t => {
  const custom = {
    APT_MIRROR: 'https://mirror.example.invalid/debian',
    HTTP_PROXY: 'http://proxy.example.invalid:8080',
    HTTPS_PROXY: 'http://secure-proxy.example.invalid:8443',
    NO_PROXY: 'localhost,.example.invalid',
  }
  const { config } = composeConfig(t, [globalCompose, chinaCompose], custom)
  const service = serviceOf(config)

  assert.equal(service.build.args.APT_MIRROR, custom.APT_MIRROR)
  assert.equal(service.build.args.HTTP_PROXY, custom.HTTP_PROXY)
  assert.equal(service.build.args.HTTPS_PROXY, custom.HTTPS_PROXY)
  assert.equal(service.build.args.NO_PROXY, custom.NO_PROXY)
  assert.equal(service.environment.HTTP_PROXY, custom.HTTP_PROXY)
  assert.equal(service.environment.HTTPS_PROXY, custom.HTTPS_PROXY)
  assert.equal(service.environment.NO_PROXY, custom.NO_PROXY)
})

test('Dockerfile parameterizes the base and registry while restoring apt sources', () => {
  const text = readFileSync(dockerfile, 'utf8')
  const nodeArg = text.indexOf('ARG NODE_IMAGE=node:24-bookworm-slim')
  const from = text.indexOf('FROM ${NODE_IMAGE}')
  const aptMirror = text.indexOf('ARG APT_MIRROR=')
  const aptUpdate = text.indexOf('apt-get update')
  const backup = text.indexOf('mv /etc/apt/sources.list.d /tmp/testbed-sources.list.d')
  const restoreCall = text.lastIndexOf('restore_apt_sources;')

  assert.ok(nodeArg >= 0 && from > nodeArg, 'NODE_IMAGE ARG must precede parameterized FROM')
  assert.ok(aptMirror > from && aptMirror < aptUpdate, 'APT_MIRROR must be a build arg used before apt')
  assert.ok(backup > aptMirror && backup < aptUpdate, 'apt source directory must be replaced without assuming its file format')
  assert.ok(restoreCall > aptUpdate, 'official apt sources must be restored after package installation')
  assert.match(text, /ENV[\s\S]*NPM_CONFIG_REGISTRY=\$\{NPM_REGISTRY\}/)
  assert.match(text, /rm -rf \/var\/lib\/apt\/lists\/\*/)
  assert.doesNotMatch(text, /^ENV[^\n]*(?:HTTP|HTTPS|NO)_PROXY/m, 'proxy values must not be persisted in the image')
})

function makeDockerStub(t, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'quota-docker-stub-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const trace = join(dir, 'args.txt')
  const cwdTrace = join(dir, 'cwd.txt')
  const configTrace = join(dir, 'docker-config.txt')
  const stub = join(dir, 'docker')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "$DOCKER_STUB_TRACE"\nprintf '%s\\n' "$PWD" > "$DOCKER_STUB_CWD_TRACE"\nprintf '%s\\n' "$DOCKER_CONFIG" > "$DOCKER_STUB_CONFIG_TRACE"\nexit "\${DOCKER_STUB_EXIT:-0}"\n`)
  chmodSync(stub, 0o755)
  return {
    trace,
    cwdTrace,
    configTrace,
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      DOCKER_CONFIG: '',
      DOCKER_STUB_TRACE: trace,
      DOCKER_STUB_CWD_TRACE: cwdTrace,
      DOCKER_STUB_CONFIG_TRACE: configTrace,
      DOCKER_STUB_EXIT: String(exitCode),
    },
  }
}

function runLauncher(args, env) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
}

function tracedArgs(path) {
  return readFileSync(path, 'utf8').trimEnd().split('\n')
}

test('launcher defaults local runs to China and emits the exact Compose files', t => {
  const stub = makeDockerStub(t)
  const result = runLauncher([], stub.env)

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(tracedArgs(stub.trace), [
    'compose',
    '-f', globalCompose,
    '-f', chinaCompose,
    'run', '--rm', '--build', 'testbed',
  ])
  assert.equal(resolve(readFileSync(stub.cwdTrace, 'utf8').trim()), resolve(testbedDir))
  assert.match(result.stdout, /network=china/)
  assert.match(result.stdout, /compose\.yaml.*compose\.china\.yaml/)
})

test('launcher defaults DOCKER_CONFIG locally and preserves an explicit override', t => {
  const defaultStub = makeDockerStub(t)
  const defaultResult = runLauncher(['--network', 'china', 'config'], defaultStub.env)
  assert.equal(defaultResult.status, 0, defaultResult.stderr)
  assert.equal(
    resolve(readFileSync(defaultStub.configTrace, 'utf8').trim()),
    resolve(testbedDir, '.docker-config'),
  )

  const explicitStub = makeDockerStub(t)
  const customConfig = join(dirname(explicitStub.trace), 'custom-docker-config')
  const explicitResult = runLauncher(['--network', 'global', 'config'], {
    ...explicitStub.env,
    DOCKER_CONFIG: customConfig,
  })
  assert.equal(explicitResult.status, 0, explicitResult.stderr)
  assert.equal(readFileSync(explicitStub.configTrace, 'utf8').trim(), customConfig)
})

test('launcher uses only global Compose for CI reproduction and forwards arguments', t => {
  const stub = makeDockerStub(t)
  const result = runLauncher(['--network', 'global', 'build', '--pull', 'testbed'], stub.env)

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(tracedArgs(stub.trace), [
    'compose',
    '-f', globalCompose,
    'build', '--pull', 'testbed',
  ])
  assert.match(result.stdout, /network=global/)
  assert.doesNotMatch(result.stdout, /compose\.china\.yaml/)
})

test('launcher propagates Docker exit codes and rejects invalid networks before spawn', t => {
  const failingStub = makeDockerStub(t, 37)
  const failed = runLauncher(['--network=china', 'config'], failingStub.env)
  assert.equal(failed.status, 37)

  const rejectedStub = makeDockerStub(t)
  const rejected = runLauncher(['--network', 'regional'], rejectedStub.env)
  assert.equal(rejected.status, 2)
  assert.match(rejected.stderr, /global\|china/)
  assert.equal(existsSync(rejectedStub.trace), false, 'invalid mode must not invoke docker')
})

test('China env example contains only non-secret network knobs', () => {
  const text = readFileSync(chinaEnvExample, 'utf8')
  assert.match(text, /^NODE_IMAGE=docker\.m\.daocloud\.io\/library\/node:24-bookworm-slim$/m)
  assert.match(text, /^NPM_REGISTRY=https:\/\/registry\.npmmirror\.com$/m)
  assert.match(text, /^APT_MIRROR=http:\/\/mirrors\.aliyun\.com\/debian$/m)
  assert.match(text, /^# HTTP_PROXY=/m)
  assert.match(text, /^# HTTPS_PROXY=/m)
  assert.match(text, /^# NO_PROXY=/m)
  assert.doesNotMatch(text, /(?:TOKEN|PASSWORD|_AUTH)=/i)
})

test('network-selection skill has trigger-only metadata and canonical commands', () => {
  const text = readFileSync(networkSkill, 'utf8')
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatter, 'skill must have YAML frontmatter')
  assert.match(frontmatter[1], /^name: dsh-plugin-testbed-network$/m)
  assert.match(frontmatter[1], /^description: Use when /m)
  assert.doesNotMatch(frontmatter[1], /run\.mjs|china|global|defaults|selects/i, 'description must contain triggers, not workflow')
  assert.match(text, /node testbed\/run\.mjs --network china/)
  assert.match(text, /node testbed\/run\.mjs --network global/)
})
