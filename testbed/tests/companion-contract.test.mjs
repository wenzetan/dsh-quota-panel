import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

import {
  COMBO_CONTRACT,
  assertMountReadonly,
  parseMountInfo,
  parsePackJson,
  validateTarPackage,
} from '../probes/companion-contract.mjs'

const testbedDir = fileURLToPath(new URL('../', import.meta.url))
const probe = join(testbedDir, 'probes/companion-contract.mjs')
const EXPECTED_CONTRACT = {
  self: {
    package: { name: 'dsh-quota-panel', version: '0.9.2-rc.4' },
    clientId: 'dsh-quota-panel',
    rpc: {
      route: '/api/dsh-quota-panel/specs',
      request: {
        type: 'client-request',
        rpcId: 'combo-self',
        method: 'dsh-quota-panel/specs',
        payload: null,
      },
      expect: {
        type: 'server-response',
        rpcId: 'combo-self',
        result: { ok: true, value: { rows: 'array' } },
      },
    },
  },
  peer: {
    package: { name: 'dsh-llm-newapi', version: '0.8.6-rc.3' },
    clientId: 'dsh-llm-newapi',
    rpc: {
      route: '/llm-newapi/ci-probe',
      request: {
        type: 'client-request',
        rpcId: 'combo-peer',
        method: 'ci-probe',
        payload: {},
      },
      expect: {
        type: 'server-response',
        rpcId: 'combo-peer',
        result: {
          ok: false,
          error: {
            code: 'internal',
            message: 'llm-newapi: unknown endpoint ci-probe',
            details: {},
          },
        },
      },
    },
  },
}

const packReport = (overrides = {}) => JSON.stringify([{
  id: 'dsh-llm-newapi@0.8.6-rc.3',
  name: 'dsh-llm-newapi',
  version: '0.8.6-rc.3',
  filename: 'dsh-llm-newapi-0.8.6-rc.3.tgz',
  size: 123,
  ...overrides,
}])
const validPack = () => parsePackJson(packReport())
const mountLine = ({
  id = 36,
  parent = 25,
  root = '/',
  target = '/companion-src',
  options = 'ro,nosuid,nodev',
  optional = '',
  filesystem = 'ext4',
  source = '/dev/root',
  superOptions = 'rw,relatime',
} = {}) => `${id} ${parent} 0:32 ${root} ${target} ${options}${optional ? ` ${optional}` : ''} - ${filesystem} ${source} ${superOptions}`

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

function assertDataOnly(value) {
  assert.notEqual(typeof value, 'function')
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) assertDataOnly(child)
}

function rejectsFixed(operation, expected, forbidden = []) {
  assert.throws(operation, error => {
    assert.equal(error.message, expected)
    for (const marker of forbidden) assert.doesNotMatch(error.message, new RegExp(marker, 'i'))
    return true
  })
}

function tempFiles(t, entries) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return Object.fromEntries(Object.entries(entries).map(([name, value]) => {
    const path = join(directory, name)
    writeFileSync(path, value)
    return [name, path]
  }))
}

function cli(args, input = undefined) {
  return spawnSync(process.execPath, [probe, ...args], {
    encoding: 'utf8',
    input,
  })
}

test('COMBO_CONTRACT contains the exact package, client, request, and response identities', () => {
  assert.deepEqual(COMBO_CONTRACT, EXPECTED_CONTRACT)
  assert.deepEqual(JSON.parse(JSON.stringify(COMBO_CONTRACT)), EXPECTED_CONTRACT)
  assertDataOnly(COMBO_CONTRACT)
})

test('COMBO_CONTRACT is recursively frozen', () => {
  assertDeepFrozen(COMBO_CONTRACT)
  assert.throws(() => { COMBO_CONTRACT.peer.rpc.request.method = 'changed' }, TypeError)
  assert.equal(COMBO_CONTRACT.peer.rpc.request.method, 'ci-probe')
})

test('importing the module has no stdout or stderr side effects', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(probe).href)})`,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('contract CLI consumes and emits the exported contract exactly', () => {
  const result = cli(['contract'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), COMBO_CONTRACT)
})

test('parseMountInfo decodes kernel octal escapes and keeps pre-separator options', () => {
  assert.deepEqual(parseMountInfo(
    `${mountLine({ root: '/source\\040root', target: '/companion\\040src', options: 'ro,nodev', source: '/dev/mapper/a\\134b' })}\n`,
  ), [{
    root: '/source root',
    mountPoint: '/companion src',
    options: ['ro', 'nodev'],
    filesystem: 'ext4',
    source: '/dev/mapper/a\\b',
  }])
})

test('assertMountReadonly accepts an exact ro token even when super options say rw', () => {
  assert.deepEqual(assertMountReadonly(`${mountLine()}\n`, '/companion-src'), { readonly: true })
})

test('assertMountReadonly uses the last exact matching record as the effective mount', () => {
  const text = [
    mountLine({ id: 35, options: 'rw' }),
    mountLine({ id: 36, target: '/companion-src-child', options: 'rw' }),
    mountLine({ id: 37, options: 'ro' }),
  ].join('\n')
  assert.deepEqual(assertMountReadonly(text, '/companion-src'), { readonly: true })
})

test('assertMountReadonly fails when a later rw record covers an earlier ro record', () => {
  const text = `${mountLine({ id: 35, options: 'ro' })}\n${mountLine({ id: 36, options: 'rw' })}\n`
  rejectsFixed(() => assertMountReadonly(text, '/companion-src'), 'mount target must be read-only')
})

test('assertMountReadonly matches a decoded target containing whitespace exactly', () => {
  const text = `${mountLine({ target: '/companion\\040src', options: 'ro' })}\n`
  assert.deepEqual(assertMountReadonly(text, '/companion src'), { readonly: true })
  rejectsFixed(() => assertMountReadonly(text, '/companion'), 'mount target must be present')
})

for (const [name, options] of [
  ['rw', 'rw,nosuid'],
  ['missing ro', 'nosuid,nodev'],
  ['ro only inside another token', 'rw,errors=remount-ro'],
]) {
  test(`assertMountReadonly rejects ${name} mount options`, () => {
    rejectsFixed(
      () => assertMountReadonly(`${mountLine({ options })}\n`, '/companion-src'),
      'mount target must be read-only',
    )
  })
}

test('assertMountReadonly rejects a missing exact target without echoing mount data', () => {
  rejectsFixed(
    () => assertMountReadonly(`${mountLine({ target: '/SYNTHETIC_SECRET_TARGET' })}\n`, '/companion-src'),
    'mount target must be present',
    ['SYNTHETIC', 'SECRET'],
  )
})

for (const [name, text] of [
  ['empty input', ''],
  ['missing separator', '36 25 0:32 / /SYNTHETIC_BAD rw ext4 /dev/root rw'],
  ['missing fields after separator', '36 25 0:32 / /SYNTHETIC_BAD rw - ext4'],
  ['invalid device field', '36 25 SYNTHETIC_DEVICE / /target ro - ext4 /dev/root rw'],
  ['invalid escaped path', '36 25 0:32 / /SYNTHETIC\\999 ro - ext4 /dev/root rw'],
  ['blank record among records', `${mountLine()}\n\n${mountLine({ id: 37 })}`],
]) {
  test(`parseMountInfo rejects ${name} with a fixed non-echoing error`, () => {
    rejectsFixed(() => parseMountInfo(text), 'mountinfo must contain only valid records', ['SYNTHETIC'])
  })
}

test('parseMountInfo rejects non-string input', () => {
  rejectsFixed(() => parseMountInfo({ hidden: 'SYNTHETIC_VALUE' }), 'mountinfo must be text', ['SYNTHETIC'])
})

test('mount-readonly CLI accepts a file and emits only a safe summary', t => {
  const files = tempFiles(t, { mountinfo: `${mountLine()}\n` })
  const result = cli(['mount-readonly', files.mountinfo, '/companion-src'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'mount readonly=true\n')
  assert.equal(result.stderr, '')
})

test('mount-readonly CLI accepts stdin', () => {
  const result = cli(['mount-readonly', '-', '/companion-src'], `${mountLine()}\n`)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'mount readonly=true\n')
  assert.equal(result.stderr, '')
})

test('mount-readonly CLI hides unreadable paths and input content', () => {
  const result = cli(['mount-readonly', '/SYNTHETIC_SECRET_MISSING', '/companion-src'])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'companion-contract: input file must be readable\n')
  assert.doesNotMatch(result.stderr, /SYNTHETIC|SECRET/)
})

test('parsePackJson returns only the validated package identity and safe filename', () => {
  assert.deepEqual(parsePackJson(packReport()), {
    name: 'dsh-llm-newapi',
    version: '0.8.6-rc.3',
    filename: 'dsh-llm-newapi-0.8.6-rc.3.tgz',
  })
})

test('parsePackJson allows surrounding JSON whitespace but rejects prefix and suffix pollution', () => {
  assert.deepEqual(parsePackJson(` \n${packReport()}\t`), validPack())
  rejectsFixed(
    () => parsePackJson(`SYNTHETIC_PREFIX\n${packReport()}`),
    'pack report must be one complete JSON document',
    ['SYNTHETIC'],
  )
  rejectsFixed(
    () => parsePackJson(`${packReport()}\nSYNTHETIC_SUFFIX`),
    'pack report must be one complete JSON document',
    ['SYNTHETIC'],
  )
})

for (const [name, value, message] of [
  ['zero results', [], 'pack report must contain exactly one result'],
  ['two results', [{}, {}], 'pack report must contain exactly one result'],
  ['missing result array', {}, 'pack report must contain exactly one result'],
  ['null result', [null], 'pack result must be an object'],
  ['array result', [[]], 'pack result must be an object'],
]) {
  test(`parsePackJson rejects ${name}`, () => {
    rejectsFixed(() => parsePackJson(JSON.stringify(value)), message)
  })
}

for (const [name, overrides, message] of [
  ['missing name', { name: undefined }, 'pack result name must be dsh-llm-newapi'],
  ['empty name', { name: '' }, 'pack result name must be dsh-llm-newapi'],
  ['wrong name', { name: 'SYNTHETIC_PACKAGE' }, 'pack result name must be dsh-llm-newapi'],
  ['missing version', { version: undefined }, 'pack result version must be 0.8.6-rc.3'],
  ['empty version', { version: '' }, 'pack result version must be 0.8.6-rc.3'],
  ['wrong version', { version: 'SYNTHETIC_VERSION' }, 'pack result version must be 0.8.6-rc.3'],
  ['missing filename', { filename: undefined }, 'pack result filename must be a safe .tgz basename'],
  ['empty filename', { filename: '' }, 'pack result filename must be a safe .tgz basename'],
  ['wrong extension', { filename: 'SYNTHETIC.tar.gz' }, 'pack result filename must be a safe .tgz basename'],
  ['slash traversal', { filename: '../SYNTHETIC.tgz' }, 'pack result filename must be a safe .tgz basename'],
  ['backslash traversal', { filename: '..\\SYNTHETIC.tgz' }, 'pack result filename must be a safe .tgz basename'],
  ['absolute path', { filename: '/tmp/SYNTHETIC.tgz' }, 'pack result filename must be a safe .tgz basename'],
  ['embedded newline', { filename: 'safe.tgz\nSYNTHETIC' }, 'pack result filename must be a safe .tgz basename'],
]) {
  test(`parsePackJson rejects ${name} without echoing values`, () => {
    rejectsFixed(() => parsePackJson(packReport(overrides)), message, ['SYNTHETIC'])
  })
}

test('parsePackJson rejects non-string and malformed JSON without echoing it', () => {
  rejectsFixed(() => parsePackJson({ secret: 'SYNTHETIC_VALUE' }), 'pack report must be text', ['SYNTHETIC'])
  rejectsFixed(() => parsePackJson('[{"marker":"SYNTHETIC_JSON"}'), 'pack report must be one complete JSON document', ['SYNTHETIC'])
})

test('validateTarPackage matches package metadata and one exact client member', () => {
  assert.deepEqual(validateTarPackage(
    { name: 'dsh-llm-newapi', version: '0.8.6-rc.3', private: false },
    ['package/package.json', 'package/lib/index.js', 'package/lib/client.js'],
    validPack(),
  ), {
    name: 'dsh-llm-newapi',
    version: '0.8.6-rc.3',
    clientMember: 'package/lib/client.js',
  })
})

for (const [name, metadata, message] of [
  ['null metadata', null, 'tar metadata must be an object'],
  ['array metadata', [], 'tar metadata must be an object'],
  ['wrong name', { name: 'SYNTHETIC_NAME', version: '0.8.6-rc.3' }, 'tar metadata must match the pack result'],
  ['wrong version', { name: 'dsh-llm-newapi', version: 'SYNTHETIC_VERSION' }, 'tar metadata must match the pack result'],
  ['missing version', { name: 'dsh-llm-newapi' }, 'tar metadata must match the pack result'],
]) {
  test(`validateTarPackage rejects ${name} without echoing metadata`, () => {
    rejectsFixed(() => validateTarPackage(metadata, ['package/lib/client.js'], validPack()), message, ['SYNTHETIC'])
  })
}

for (const [name, members, message] of [
  ['non-array members', { member: 'SYNTHETIC_MEMBER' }, 'tar members must be an array of strings'],
  ['non-string member', ['package/lib/client.js', { hidden: 'SYNTHETIC_MEMBER' }], 'tar members must be an array of strings'],
  ['missing client', ['package/lib/index.js', 'SYNTHETIC/client.js'], 'tar members must contain package/lib/client.js exactly once'],
  ['similar suffix only', ['prefix/package/lib/client.js'], 'tar members must contain package/lib/client.js exactly once'],
  ['duplicate client', ['package/lib/client.js', 'package/lib/client.js'], 'tar members must contain package/lib/client.js exactly once'],
]) {
  test(`validateTarPackage rejects ${name} without echoing member data`, () => {
    rejectsFixed(() => validateTarPackage({ name: 'dsh-llm-newapi', version: '0.8.6-rc.3' }, members, validPack()), message, ['SYNTHETIC'])
  })
}

test('validateTarPackage rejects an unvalidated pack result', () => {
  rejectsFixed(
    () => validateTarPackage(
      { name: 'dsh-llm-newapi', version: '0.8.6-rc.3' },
      ['package/lib/client.js'],
      { name: 'SYNTHETIC_PACKAGE', version: '0.8.6-rc.3', filename: 'safe.tgz' },
    ),
    'pack result must be validated',
    ['SYNTHETIC'],
  )
})

test('pack CLI accepts stdin and emits normalized safe JSON only', () => {
  const result = cli(['pack', '-'], packReport())
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), validPack())
})

test('tar CLI validates small JSON files and emits a safe summary', t => {
  const files = tempFiles(t, {
    'metadata.json': JSON.stringify({ name: 'dsh-llm-newapi', version: '0.8.6-rc.3', scripts: { hidden: 'SYNTHETIC_SCRIPT' } }),
    'members.json': JSON.stringify(['package/package.json', 'package/lib/client.js']),
    'pack.json': packReport(),
  })
  const result = cli(['tar', files['metadata.json'], files['members.json'], files['pack.json']])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    name: 'dsh-llm-newapi',
    version: '0.8.6-rc.3',
    clientMember: 'package/lib/client.js',
  })
  assert.doesNotMatch(result.stdout, /SYNTHETIC|scripts|hidden/)
})

test('tar CLI accepts metadata from stdin', t => {
  const files = tempFiles(t, {
    'members.json': JSON.stringify(['package/lib/client.js']),
    'pack.json': packReport(),
  })
  const result = cli(
    ['tar', '-', files['members.json'], files['pack.json']],
    JSON.stringify({ name: 'dsh-llm-newapi', version: '0.8.6-rc.3' }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), validateTarPackage(
    { name: 'dsh-llm-newapi', version: '0.8.6-rc.3' },
    ['package/lib/client.js'],
    validPack(),
  ))
})

test('CLI rejects unknown commands and extra arguments with one fixed usage line', () => {
  const expected = 'companion-contract: usage: companion-contract.mjs contract | mount-readonly <mountinfo-file|-> <target> | pack <pack-json-file|-> | tar <metadata-json-file|-> <members-json-file> <pack-json-file>\n'
  for (const args of [[], ['SYNTHETIC_COMMAND'], ['contract', 'SYNTHETIC_EXTRA'], ['pack']]) {
    const result = cli(args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, expected)
    assert.doesNotMatch(result.stderr, /SYNTHETIC/)
  }
})
