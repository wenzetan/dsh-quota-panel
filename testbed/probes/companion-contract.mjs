import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootPayloadFromHtml } from './rpc-contract.mjs'

const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const PEER_NAME = 'dsh-llm-newapi'
const PEER_VERSION = '0.8.6-rc.3'
const CLIENT_MEMBER = 'package/lib/client.js'
const USAGE = 'usage: companion-contract.mjs contract | clients <html-file|-> | mount-readonly <mountinfo-file|-> <target> | pack <pack-json-file|-> | tar <metadata-json-file|-> <members-json-file> <pack-json-file>'

function fail(message) {
  throw new TypeError(message)
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function validateContract(contract) {
  if (!OBJECT(contract) || !OBJECT(contract.self) || !OBJECT(contract.peer)) {
    fail('combo contract must contain self and peer objects')
  }
  const expected = [
    [contract.self.package?.name, 'dsh-quota-panel'],
    [contract.self.package?.version, '0.9.2-rc.4'],
    [contract.self.clientId, 'dsh-quota-panel'],
    [contract.self.rpc?.route, '/api/dsh-quota-panel/specs'],
    [contract.self.rpc?.request?.type, 'client-request'],
    [contract.self.rpc?.request?.rpcId, 'combo-self'],
    [contract.self.rpc?.request?.method, 'dsh-quota-panel/specs'],
    [contract.self.rpc?.expect?.type, 'server-response'],
    [contract.self.rpc?.expect?.rpcId, 'combo-self'],
    [contract.self.rpc?.expect?.result?.ok, true],
    [contract.self.rpc?.expect?.result?.value?.rows, 'array'],
    [contract.peer.package?.name, PEER_NAME],
    [contract.peer.package?.version, PEER_VERSION],
    [contract.peer.clientId, PEER_NAME],
    [contract.peer.rpc?.route, '/llm-newapi/ci-probe'],
    [contract.peer.rpc?.request?.type, 'client-request'],
    [contract.peer.rpc?.request?.rpcId, 'combo-peer'],
    [contract.peer.rpc?.request?.method, 'ci-probe'],
    [contract.peer.rpc?.expect?.type, 'server-response'],
    [contract.peer.rpc?.expect?.rpcId, 'combo-peer'],
    [contract.peer.rpc?.expect?.result?.ok, false],
    [contract.peer.rpc?.expect?.result?.error?.code, 'internal'],
    [contract.peer.rpc?.expect?.result?.error?.message, 'llm-newapi: unknown endpoint ci-probe'],
  ]
  if (expected.some(([actual, wanted]) => actual !== wanted)) {
    fail('combo contract constants must match the validated identities')
  }
  if (contract.self.rpc.request.payload !== null
    || !OBJECT(contract.peer.rpc.request.payload)
    || Object.keys(contract.peer.rpc.request.payload).length !== 0
    || !OBJECT(contract.peer.rpc.expect.result.error.details)
    || Object.keys(contract.peer.rpc.expect.result.error.details).length !== 0) {
    fail('combo contract request and expectation objects must be valid')
  }
  const visit = value => {
    if (typeof value === 'function') fail('combo contract must contain data only')
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child)
    }
  }
  visit(contract)
  return contract
}

export const COMBO_CONTRACT = deepFreeze(validateContract({
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
    package: { name: PEER_NAME, version: PEER_VERSION },
    clientId: PEER_NAME,
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
}))

function comboClientContract(contract) {
  if (!OBJECT(contract) || !OBJECT(contract.self) || !OBJECT(contract.peer)) return undefined
  const rows = [contract.self, contract.peer]
  if (!rows.every(row => typeof row.clientId === 'string'
    && row.clientId.length > 0
    && typeof row.package?.name === 'string'
    && row.package.name.length > 0)
    || new Set(rows.map(row => row.clientId)).size !== 2
    || new Set(rows.map(row => row.package.name)).size !== 2) return undefined
  return rows.map(row => ({ id: row.clientId, packageName: row.package.name }))
}

function comboClientUrl(url, packageName) {
  if (typeof url !== 'string' || url.includes('\\') || !url.startsWith('/') || url.startsWith('//')) return undefined
  const decoded = url.replace(/&amp;/gi, '&')
  let parsed
  try {
    parsed = new URL(decoded, 'http://127.0.0.1')
  } catch {
    return undefined
  }
  if (parsed.origin !== 'http://127.0.0.1') return undefined
  const plain = parsed.pathname === `/plugins/${packageName}/client.js`
  const combo = parsed.pathname === '/plugins/' && parsed.search.startsWith(`??${packageName}/client.js&`)
  if (!(plain || combo) || !parsed.searchParams.get('rev')) return undefined
  return decoded
}

export function comboClientUrlsFromBootHtml(html, contract = COMBO_CONTRACT) {
  const expected = comboClientContract(contract)
  if (expected === undefined) fail('combo boot must advertise exactly two valid client URLs')
  let payload
  try {
    payload = bootPayloadFromHtml(html)
  } catch {
    fail('combo boot must advertise exactly two valid client URLs')
  }
  const objects = []
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (typeof value.id === 'string') objects.push(value)
    for (const child of Object.values(value)) visit(child)
  }
  visit(payload)
  const result = []
  for (const row of expected) {
    const matches = objects.filter(value => value.id === row.id)
    if (matches.length !== 1) fail('combo boot must advertise exactly two valid client URLs')
    const url = comboClientUrl(matches[0].url, row.packageName)
    if (url === undefined) fail('combo boot must advertise exactly two valid client URLs')
    result.push({ id: row.id, url })
  }
  return result
}

const MOUNT_ESCAPE = Object.freeze({
  '040': ' ',
  '011': '\t',
  '012': '\n',
  '134': '\\',
})

function decodeMountField(field) {
  if (typeof field !== 'string'
    || field.length === 0
    || /[\u0000-\u001f\u007f]/.test(field)
    || /\\(?!040|011|012|134)/.test(field)) {
    fail('mountinfo must contain only valid records')
  }
  return field.replace(/\\(040|011|012|134)/g, (_match, octal) => MOUNT_ESCAPE[octal])
}

function mountOptions(field) {
  if (!field
    || /[\u0000-\u001f\u007f]/.test(field)
    || field.split(',').some(option => option.length === 0)) {
    fail('mountinfo must contain only valid records')
  }
  return field.split(',')
}

export function parseMountInfo(text) {
  if (typeof text !== 'string') fail('mountinfo must be text')
  const withoutFinalNewline = text.endsWith('\n') ? text.slice(0, -1) : text
  if (!withoutFinalNewline || withoutFinalNewline.includes('\n\n') || withoutFinalNewline.includes('\r')) {
    fail('mountinfo must contain only valid records')
  }

  return withoutFinalNewline.split('\n').map(line => {
    if (!line || /^\s|\s$/.test(line)) fail('mountinfo must contain only valid records')
    const fields = line.split(' ')
    const separator = fields.indexOf('-')
    if (fields.some(field => field.length === 0)
      || separator < 6
      || separator !== fields.lastIndexOf('-')
      || fields.length !== separator + 4
      || !/^\d+$/.test(fields[0])
      || !/^\d+$/.test(fields[1])
      || !/^\d+:\d+$/.test(fields[2])
      || fields.slice(6, separator).some(field => !/^[^\s]+$/.test(field))) {
      fail('mountinfo must contain only valid records')
    }
    const root = decodeMountField(fields[3])
    const mountPoint = decodeMountField(fields[4])
    const options = mountOptions(fields[5])
    const filesystem = decodeMountField(fields[separator + 1])
    const source = decodeMountField(fields[separator + 2])
    mountOptions(fields[separator + 3])
    return { root, mountPoint, options, filesystem, source }
  })
}

export function assertMountReadonly(text, target) {
  if (typeof target !== 'string' || target.length === 0) fail('mount target must be a nonempty string')
  const matches = parseMountInfo(text).filter(record => record.mountPoint === target)
  if (matches.length === 0) fail('mount target must be present')
  const modeOptions = matches.at(-1).options.filter(option => option === 'ro' || option === 'rw')
  if (modeOptions.length !== 1 || modeOptions[0] !== 'ro') fail('mount target must be read-only')
  return { readonly: true }
}

function safeTarballFilename(filename) {
  return typeof filename === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/.test(filename)
    && !filename.includes('/')
    && !filename.includes('\\')
}

function validatePackResult(result, messagePrefix = 'pack result') {
  if (!OBJECT(result)) fail(`${messagePrefix} must be an object`)
  if (result.name !== PEER_NAME) fail(`${messagePrefix} name must be ${PEER_NAME}`)
  if (result.version !== PEER_VERSION) fail(`${messagePrefix} version must be ${PEER_VERSION}`)
  if (!safeTarballFilename(result.filename)) fail(`${messagePrefix} filename must be a safe .tgz basename`)
  return {
    name: result.name,
    version: result.version,
    filename: result.filename,
  }
}

export function parsePackJson(text) {
  if (typeof text !== 'string') fail('pack report must be text')
  let report
  try {
    report = JSON.parse(text)
  } catch {
    fail('pack report must be one complete JSON document')
  }
  if (!Array.isArray(report) || report.length !== 1) {
    fail('pack report must contain exactly one result')
  }
  return validatePackResult(report[0])
}

function normalizedPackResult(packResult) {
  try {
    return validatePackResult(packResult)
  } catch {
    fail('pack result must be validated')
  }
}

export function validateTarPackage(metadata, members, packResult) {
  const pack = normalizedPackResult(packResult)
  if (!OBJECT(metadata)) fail('tar metadata must be an object')
  if (metadata.name !== pack.name || metadata.version !== pack.version) {
    fail('tar metadata must match the pack result')
  }
  if (!Array.isArray(members) || !members.every(member => typeof member === 'string')) {
    fail('tar members must be an array of strings')
  }
  if (members.filter(member => member === CLIENT_MEMBER).length !== 1) {
    fail(`tar members must contain ${CLIENT_MEMBER} exactly once`)
  }
  return {
    name: pack.name,
    version: pack.version,
    clientMember: CLIENT_MEMBER,
  }
}

function readInput(path) {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8')
  } catch {
    fail('input file must be readable')
  }
}

function parseJsonInput(path, kind) {
  try {
    return JSON.parse(readInput(path))
  } catch (error) {
    if (error instanceof TypeError && error.message === 'input file must be readable') throw error
    fail(`${kind} must be one complete JSON document`)
  }
}

async function runCli(argv) {
  const [command, ...args] = argv
  if (command === 'contract' && args.length === 0) {
    process.stdout.write(`${JSON.stringify(COMBO_CONTRACT)}\n`)
    return
  }
  if (command === 'clients' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(comboClientUrlsFromBootHtml(readInput(args[0])))}\n`)
    return
  }
  if (command === 'mount-readonly' && args.length === 2) {
    const summary = assertMountReadonly(readInput(args[0]), args[1])
    process.stdout.write(`mount readonly=${summary.readonly}\n`)
    return
  }
  if (command === 'pack' && args.length === 1) {
    process.stdout.write(`${JSON.stringify(parsePackJson(readInput(args[0])))}\n`)
    return
  }
  if (command === 'tar' && args.length === 3) {
    const metadata = parseJsonInput(args[0], 'tar metadata')
    const members = parseJsonInput(args[1], 'tar members')
    const pack = parsePackJson(readInput(args[2]))
    process.stdout.write(`${JSON.stringify(validateTarPackage(metadata, members, pack))}\n`)
    return
  }
  fail(USAGE)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`companion-contract: ${error instanceof Error ? error.message : 'operation failed'}\n`)
    process.exitCode = 1
  }
}
