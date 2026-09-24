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
const globalEnvExample = join(testbedDir, '.env.example')
const chinaEnvExample = join(testbedDir, '.env.china.example')
const networkSkill = join(repoRoot, '.dsh/skills/dsh-plugin-testbed-network/SKILL.md')

const deterministicEnv = {
  NODE_IMAGE: '',
  NPM_REGISTRY: '',
  APT_MIRROR: '',
  APT_SECURITY_MIRROR: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  NO_PROXY: '',
  GLOBAL_NODE_IMAGE: '',
  GLOBAL_NPM_REGISTRY: '',
  GLOBAL_APT_MIRROR: '',
  GLOBAL_APT_SECURITY_MIRROR: '',
  GLOBAL_HTTP_PROXY: '',
  GLOBAL_HTTPS_PROXY: '',
  GLOBAL_NO_PROXY: '',
  CHINA_NODE_IMAGE: '',
  CHINA_NPM_REGISTRY: '',
  CHINA_APT_MIRROR: '',
  CHINA_APT_SECURITY_MIRROR: '',
  CHINA_HTTP_PROXY: '',
  CHINA_HTTPS_PROXY: '',
  CHINA_NO_PROXY: '',
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

test('global Compose ignores a complete China and legacy unscoped environment', t => {
  const chinaPollution = {
    CHINA_NODE_IMAGE: 'docker.m.daocloud.io/library/node:24-bookworm-slim',
    CHINA_NPM_REGISTRY: 'https://registry.npmmirror.com',
    CHINA_APT_MIRROR: 'http://mirrors.aliyun.com/debian',
    CHINA_APT_SECURITY_MIRROR: 'http://mirrors.aliyun.com/debian-security',
    CHINA_HTTP_PROXY: 'http://china-proxy.example.invalid:8080',
    CHINA_HTTPS_PROXY: 'http://china-proxy.example.invalid:8443',
    CHINA_NO_PROXY: 'localhost,.china.example.invalid',
    NODE_IMAGE: 'docker.m.daocloud.io/library/node:24-bookworm-slim',
    NPM_REGISTRY: 'https://registry.npmmirror.com',
    APT_MIRROR: 'http://mirrors.aliyun.com/debian',
    APT_SECURITY_MIRROR: 'http://mirrors.aliyun.com/debian-security',
    HTTP_PROXY: 'http://china-proxy.example.invalid:8080',
    HTTPS_PROXY: 'http://china-proxy.example.invalid:8443',
    NO_PROXY: 'localhost,.china.example.invalid',
  }
  const { config, text } = composeConfig(t, [globalCompose], chinaPollution)
  const service = serviceOf(config)

  assert.equal(config.name, 'dsh-testbed-quota-panel')
  assert.equal(service.image, 'dsh-testbed-quota-panel:0.1.5-rc.3')
  assert.equal(service.build.args.NODE_IMAGE, 'node:24-bookworm-slim')
  assert.equal(service.build.args.NPM_REGISTRY, 'https://registry.npmjs.org')
  assert.equal(service.build.args.APT_MIRROR, '')
  assert.equal(service.build.args.APT_SECURITY_MIRROR, '')
  assert.equal(service.build.args.HTTP_PROXY, '')
  assert.equal(service.build.args.HTTPS_PROXY, '')
  assert.equal(service.build.args.NO_PROXY, '')
  assert.equal(service.environment.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org')
  assert.equal(service.environment.HTTP_PROXY, '')
  assert.equal(service.environment.HTTPS_PROXY, '')
  assert.equal(service.environment.NO_PROXY, '')
  assert.doesNotMatch(text, /daocloud|npmmirror|mirrors\.(?:aliyun|tuna|ustc)|\.cn(?:[/:]|$)/i)
})

test('global Compose preserves explicit global-only network overrides', t => {
  const custom = {
    GLOBAL_NODE_IMAGE: 'registry.example.invalid/library/node:24-bookworm-slim',
    GLOBAL_NPM_REGISTRY: 'https://npm.example.invalid',
    GLOBAL_APT_MIRROR: 'https://apt.example.invalid/debian',
    GLOBAL_APT_SECURITY_MIRROR: 'https://security.example.invalid/debian-security',
    GLOBAL_HTTP_PROXY: 'http://global-proxy.example.invalid:8080',
    GLOBAL_HTTPS_PROXY: 'http://global-proxy.example.invalid:8443',
    GLOBAL_NO_PROXY: 'localhost,.global.example.invalid',
  }
  const { config } = composeConfig(t, [globalCompose], custom)
  const service = serviceOf(config)

  assert.equal(service.build.args.NODE_IMAGE, custom.GLOBAL_NODE_IMAGE)
  assert.equal(service.build.args.NPM_REGISTRY, custom.GLOBAL_NPM_REGISTRY)
  assert.equal(service.build.args.APT_MIRROR, custom.GLOBAL_APT_MIRROR)
  assert.equal(service.build.args.APT_SECURITY_MIRROR, custom.GLOBAL_APT_SECURITY_MIRROR)
  assert.equal(service.build.args.HTTP_PROXY, custom.GLOBAL_HTTP_PROXY)
  assert.equal(service.build.args.HTTPS_PROXY, custom.GLOBAL_HTTPS_PROXY)
  assert.equal(service.build.args.NO_PROXY, custom.GLOBAL_NO_PROXY)
  assert.equal(service.environment.NPM_CONFIG_REGISTRY, custom.GLOBAL_NPM_REGISTRY)
  assert.equal(service.environment.HTTP_PROXY, custom.GLOBAL_HTTP_PROXY)
  assert.equal(service.environment.HTTPS_PROXY, custom.GLOBAL_HTTPS_PROXY)
  assert.equal(service.environment.NO_PROXY, custom.GLOBAL_NO_PROXY)
})

test('China Compose ignores a complete global and legacy unscoped environment', t => {
  const globalPollution = {
    GLOBAL_NODE_IMAGE: 'registry.example.invalid/library/node:24-bookworm-slim',
    GLOBAL_NPM_REGISTRY: 'https://npm.example.invalid',
    GLOBAL_APT_MIRROR: 'https://apt.example.invalid/debian',
    GLOBAL_APT_SECURITY_MIRROR: 'https://security.example.invalid/debian-security',
    GLOBAL_HTTP_PROXY: 'http://global-proxy.example.invalid:8080',
    GLOBAL_HTTPS_PROXY: 'http://global-proxy.example.invalid:8443',
    GLOBAL_NO_PROXY: 'localhost,.global.example.invalid',
    NODE_IMAGE: 'registry.example.invalid/library/node:24-bookworm-slim',
    NPM_REGISTRY: 'https://npm.example.invalid',
    APT_MIRROR: 'https://apt.example.invalid/debian',
    APT_SECURITY_MIRROR: 'https://security.example.invalid/debian-security',
    HTTP_PROXY: 'http://global-proxy.example.invalid:8080',
    HTTPS_PROXY: 'http://global-proxy.example.invalid:8443',
    NO_PROXY: 'localhost,.global.example.invalid',
  }
  const { config } = composeConfig(t, [globalCompose, chinaCompose], globalPollution)
  const service = serviceOf(config)

  assert.equal(config.name, 'dsh-testbed-quota-panel-china')
  assert.equal(service.image, 'dsh-testbed-quota-panel-china:0.1.5-rc.3')
  assert.equal(service.build.args.NODE_IMAGE, 'docker.m.daocloud.io/library/node:24-bookworm-slim')
  assert.equal(service.build.args.NPM_REGISTRY, 'https://registry.npmmirror.com')
  assert.equal(service.build.args.APT_MIRROR, 'http://mirrors.aliyun.com/debian')
  assert.equal(service.build.args.APT_SECURITY_MIRROR, 'http://mirrors.aliyun.com/debian-security')
  assert.equal(service.build.args.HTTP_PROXY, '')
  assert.equal(service.build.args.HTTPS_PROXY, '')
  assert.equal(service.build.args.NO_PROXY, '')
  assert.equal(service.environment.NPM_CONFIG_REGISTRY, 'https://registry.npmmirror.com')
  assert.equal(service.environment.HTTP_PROXY, '')
  assert.equal(service.environment.HTTPS_PROXY, '')
  assert.equal(service.environment.NO_PROXY, '')
})

test('China Compose passes namespaced mirror and proxy overrides to build and runtime', t => {
  const custom = {
    CHINA_NODE_IMAGE: 'registry.china.example.invalid/library/node:24-bookworm-slim',
    CHINA_NPM_REGISTRY: 'https://npm.china.example.invalid',
    CHINA_APT_MIRROR: 'https://apt.china.example.invalid/debian',
    CHINA_APT_SECURITY_MIRROR: 'https://security.china.example.invalid/debian-security',
    CHINA_HTTP_PROXY: 'http://china-proxy.example.invalid:8080',
    CHINA_HTTPS_PROXY: 'http://china-proxy.example.invalid:8443',
    CHINA_NO_PROXY: 'localhost,.china.example.invalid',
  }
  const { config } = composeConfig(t, [globalCompose, chinaCompose], custom)
  const service = serviceOf(config)

  assert.equal(service.build.args.NODE_IMAGE, custom.CHINA_NODE_IMAGE)
  assert.equal(service.build.args.NPM_REGISTRY, custom.CHINA_NPM_REGISTRY)
  assert.equal(service.build.args.APT_MIRROR, custom.CHINA_APT_MIRROR)
  assert.equal(service.build.args.APT_SECURITY_MIRROR, custom.CHINA_APT_SECURITY_MIRROR)
  assert.equal(service.build.args.HTTP_PROXY, custom.CHINA_HTTP_PROXY)
  assert.equal(service.build.args.HTTPS_PROXY, custom.CHINA_HTTPS_PROXY)
  assert.equal(service.build.args.NO_PROXY, custom.CHINA_NO_PROXY)
  assert.equal(service.environment.NPM_CONFIG_REGISTRY, custom.CHINA_NPM_REGISTRY)
  assert.equal(service.environment.HTTP_PROXY, custom.CHINA_HTTP_PROXY)
  assert.equal(service.environment.HTTPS_PROXY, custom.CHINA_HTTPS_PROXY)
  assert.equal(service.environment.NO_PROXY, custom.CHINA_NO_PROXY)
})

test('Dockerfile pairs main and security mirrors and fails closed on partial configuration', () => {
  const text = readFileSync(dockerfile, 'utf8')
  const nodeArg = text.indexOf('ARG NODE_IMAGE=node:24-bookworm-slim')
  const from = text.indexOf('FROM ${NODE_IMAGE}')
  const aptMirror = text.indexOf('ARG APT_MIRROR=')
  const aptSecurityMirror = text.indexOf('ARG APT_SECURITY_MIRROR=')
  const aptUpdate = text.indexOf('apt-get update')
  const backup = text.indexOf('mv /etc/apt/sources.list.d /tmp/testbed-sources.list.d')
  const restoreCall = text.lastIndexOf('restore_apt_sources;')

  assert.ok(nodeArg >= 0 && from > nodeArg, 'NODE_IMAGE ARG must precede parameterized FROM')
  assert.ok(aptMirror > from && aptMirror < aptUpdate, 'APT_MIRROR must be a build arg used before apt')
  assert.ok(aptSecurityMirror > aptMirror && aptSecurityMirror < aptUpdate, 'APT_SECURITY_MIRROR must independently parameterize security apt')
  const missingSecurityGate = text.indexOf('[ -n "${APT_MIRROR}" ] && [ -z "${APT_SECURITY_MIRROR}" ]')
  const missingMainGate = text.indexOf('[ -z "${APT_MIRROR}" ] && [ -n "${APT_SECURITY_MIRROR}" ]')
  const pairError = text.indexOf('APT_MIRROR and APT_SECURITY_MIRROR must be configured together')
  const pairExit = text.indexOf('exit 2;', Math.min(missingSecurityGate, missingMainGate))
  assert.ok(
    missingSecurityGate >= 0 && missingMainGate >= 0 && pairError >= 0 && pairExit >= 0
      && missingSecurityGate < aptUpdate && missingMainGate < aptUpdate && pairError < aptUpdate && pairExit < aptUpdate,
    'supplying exactly one apt mirror must fail the build before apt runs',
  )
  assert.match(text, /deb %s bookworm main\\ndeb %s bookworm-updates main\\ndeb %s bookworm-security main\\n/)
  assert.match(
    text,
    /"\$\{APT_MIRROR\}" "\$\{APT_MIRROR\}" "\$\{APT_SECURITY_MIRROR\}"/,
    'bookworm-security must use APT_SECURITY_MIRROR rather than the main mirror',
  )
  assert.ok(backup > aptSecurityMirror && backup < aptUpdate, 'apt source directory must be replaced without assuming its file format')
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

test('network env examples expose only their namespaced non-secret knobs', () => {
  const globalText = readFileSync(globalEnvExample, 'utf8')
  const chinaText = readFileSync(chinaEnvExample, 'utf8')

  assert.match(globalText, /^GLOBAL_NODE_IMAGE=node:24-bookworm-slim$/m)
  assert.match(globalText, /^GLOBAL_NPM_REGISTRY=https:\/\/registry\.npmjs\.org$/m)
  assert.match(globalText, /^# GLOBAL_APT_MIRROR=$/m)
  assert.match(globalText, /^# GLOBAL_APT_SECURITY_MIRROR=$/m)
  assert.match(globalText, /^# GLOBAL_HTTP_PROXY=$/m)
  assert.match(globalText, /^# GLOBAL_HTTPS_PROXY=$/m)
  assert.match(globalText, /^# GLOBAL_NO_PROXY=/m)
  assert.doesNotMatch(globalText, /(?:^|\n)#?\s*CHINA_(?:NODE_IMAGE|NPM_REGISTRY|APT_MIRROR|APT_SECURITY_MIRROR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=/)

  assert.match(chinaText, /^CHINA_NODE_IMAGE=docker\.m\.daocloud\.io\/library\/node:24-bookworm-slim$/m)
  assert.match(chinaText, /^CHINA_NPM_REGISTRY=https:\/\/registry\.npmmirror\.com$/m)
  assert.match(chinaText, /^CHINA_APT_MIRROR=http:\/\/mirrors\.aliyun\.com\/debian$/m)
  assert.match(chinaText, /^CHINA_APT_SECURITY_MIRROR=http:\/\/mirrors\.aliyun\.com\/debian-security$/m)
  assert.match(chinaText, /^# CHINA_HTTP_PROXY=$/m)
  assert.match(chinaText, /^# CHINA_HTTPS_PROXY=$/m)
  assert.match(chinaText, /^# CHINA_NO_PROXY=/m)
  assert.doesNotMatch(chinaText, /(?:^|\n)#?\s*GLOBAL_(?:NODE_IMAGE|NPM_REGISTRY|APT_MIRROR|APT_SECURITY_MIRROR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=/)

  for (const text of [globalText, chinaText]) {
    assert.doesNotMatch(text, /(?:^|\n)#?\s*(?:NODE_IMAGE|NPM_REGISTRY|APT_MIRROR|APT_SECURITY_MIRROR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=/)
    assert.doesNotMatch(text, /(?:TOKEN|PASSWORD|_AUTH)=/i)
  }
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
