import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  bootPayloadFromHtml,
  clientUrlFromBootHtml,
  dynamicContract,
  redactLog,
  validateSpecsResponse,
} from '../probes/rpc-contract.mjs'

const pluginDir = fileURLToPath(new URL('../../', import.meta.url))
const options = { rpcId: 'testbed-probe', refreshMs: 60000 }

function response(rows = [], overrides = {}) {
  return JSON.stringify({
    type: 'server-response',
    rpcId: options.rpcId,
    result: {
      ok: true,
      value: { rows, refreshMs: options.refreshMs, ...overrides.value },
      ...overrides.result,
    },
    ...overrides.envelope,
  })
}

function rejectsWithoutEcho(text, expectedMessage, forbidden = []) {
  assert.throws(
    () => validateSpecsResponse(text, options),
    error => {
      assert.equal(error.message, expectedMessage)
      for (const value of forbidden) assert.ok(!error.message.toLowerCase().includes(value.toLowerCase()))
      return true
    },
  )
}

const balance = {
  id: 'billing',
  label: 'Balance details: https://docs.example.invalid/quota',
  kind: 'balance',
  proxy: null,
  currency: '$',
  balanceTiers: { critical: 10, warn: 20, healthy: 50 },
}
const usage = {
  id: 'usage',
  label: 'Usage',
  kind: 'usage',
  proxy: 'named-proxy',
  windowLabels: {
    rolling: 'Rolling',
    customWindow: 'https://docs.example.invalid/windows/custom',
  },
  warnPercent: 70,
  errorPercent: 90,
}

test('dynamicContract derives the specs contract without exposing module exports', async () => {
  const contract = await dynamicContract(pluginDir)
  assert.deepEqual(contract, {
    route: '/api/dsh-quota-panel/specs',
    method: 'dsh-quota-panel/specs',
    endpoints: [
      'specs',
      'fetch-all',
      'chatgpt-auth-status',
      'chatgpt-login-start',
      'chatgpt-login-cancel',
      'chatgpt-logout',
    ],
  })
  assert.deepEqual(Object.keys(contract).sort(), ['endpoints', 'method', 'route'])
})

test('dynamicContract rejects non-string endpoint exports without leaking values', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'quota-rpc-contract-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  mkdirSync(join(fixture, 'lib'))
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(fixture, 'lib/index.js'), `
    export const RPC_ENDPOINTS = ['specs', { hidden: 'SYNTHETIC_VALUE' }]
    export const rpcRoutePath = () => '/api/example/specs'
    export const rpcMethod = () => 'example/specs'
  `)
  await assert.rejects(
    dynamicContract(fixture),
    error => {
      assert.equal(error.message, 'plugin.RPC_ENDPOINTS must contain only strings')
      assert.doesNotMatch(error.message, /SYNTHETIC_VALUE/)
      return true
    },
  )
})

test('validateSpecsResponse accepts an empty rows array', () => {
  assert.deepEqual(validateSpecsResponse(response(), options), {
    rows: [],
    refreshMs: 60000,
  })
})

test('validateSpecsResponse accepts balance, usage, and info rows including URL strings', () => {
  const info = { id: 'quota-info', label: 'Quota info', kind: 'info', proxy: null }
  assert.deepEqual(validateSpecsResponse(response([balance, usage, info]), options), {
    rows: [balance, usage, info],
    refreshMs: 60000,
  })
})

for (const [name, text, message, forbidden] of [
  ['bad JSON', '{"marker":"SYNTHETIC_JSON",', '$ must be valid JSON text', ['SYNTHETIC_JSON']],
  ['wrong envelope type', response([], { envelope: { type: 'SYNTHETIC_TYPE' } }), '$.type must be "server-response"', ['SYNTHETIC_TYPE']],
  ['wrong rpcId', response([], { envelope: { rpcId: 'SYNTHETIC_RPC_ID' } }), '$.rpcId must match the expected rpcId', ['SYNTHETIC_RPC_ID']],
  ['ok false', response([], { result: { ok: false, error: { message: 'SYNTHETIC_ERROR' } } }), '$.result.ok must be true', ['SYNTHETIC_ERROR']],
  ['non-object value', JSON.stringify({ type: 'server-response', rpcId: options.rpcId, result: { ok: true, value: 'SYNTHETIC_VALUE' } }), '$.result.value must be an object', ['SYNTHETIC_VALUE']],
  ['non-array rows', response([], { value: { rows: { marker: 'SYNTHETIC_ROWS' } } }), '$.result.value.rows must be an array', ['SYNTHETIC_ROWS']],
  ['wrong refresh', response([], { value: { refreshMs: 12345 } }), '$.result.value.refreshMs must match the expected refreshMs', ['12345']],
]) {
  test(`validateSpecsResponse rejects ${name} without echoing input`, () => {
    rejectsWithoutEcho(text, message, forbidden)
  })
}

test('validateSpecsResponse rejects unknown row fields even when they contain URLs', () => {
  rejectsWithoutEcho(
    response([{ ...balance, helpUrl: 'https://synthetic.example.invalid/help' }]),
    '$.result.value.rows[*] must contain only allowed fields',
    ['synthetic', 'helpUrl'],
  )
})

for (const key of ['credential', 'SeCrEt', 'api_key', 'api-key', 'API Key', 'end-point', 'AuthoriZation', 'access_token']) {
  test(`validateSpecsResponse recursively rejects sensitive key form ${key}`, () => {
    rejectsWithoutEcho(
      response([{ ...usage, extra: { nested: { [key]: 'SYNTHETIC_SENSITIVE_VALUE' } } }]),
      '$ must not contain sensitive keys',
      ['SYNTHETIC_SENSITIVE_VALUE', key],
    )
  })
}

const wholeResponseSensitiveCases = [
  ['envelope credentials', 'cre-den_tials', (body, key, value) => { body[key] = value }],
  ['result authorization', 'AuthoriZation', (body, key, value) => { body.result[key] = value }],
  ['value secret key', 'secret_key', (body, key, value) => { body.result.value[key] = value }],
  ['usage windowLabels client secret', 'Client Secret', (body, key, value) => { body.result.value.rows[0].windowLabels[key] = value }],
  ['usage windowLabels password', 'pass-word', (body, key, value) => { body.result.value.rows[0].windowLabels[key] = value }],
  ['usage windowLabels private key', 'private_key', (body, key, value) => { body.result.value.rows[0].windowLabels[key] = value }],
  ['usage windowLabels session cookie', 'session.cookie', (body, key, value) => { body.result.value.rows[0].windowLabels[key] = value }],
  ['usage windowLabels cookie', 'COOKIE', (body, key, value) => { body.result.value.rows[0].windowLabels[key] = value }],
  ['balance tiers credentials', 'credentials', (body, key, value) => { body.result.value.rows[1].balanceTiers[key] = value }],
  ['nested array access token', 'Access Token', (body, key, value) => { body.audit = [{ nested: [{ [key]: value }] }] }],
  ['nested array refresh token', 'refresh-token', (body, key, value) => { body.result.audit = [[{ [key]: value }]] }],
  ['nested array API key', 'api.key', (body, key, value) => { body.result.value.audit = [{ [key]: value }] }],
  ['nested array endpoint', 'end_point', (body, key, value) => { body.result.value.rows[0].audit = [{ [key]: value }] }],
]

for (const [name, key, inject] of wholeResponseSensitiveCases) {
  test(`validateSpecsResponse rejects ${name} anywhere in the body without echoing it`, () => {
    const body = JSON.parse(response([
      { ...usage, windowLabels: { ...usage.windowLabels } },
      { ...balance, balanceTiers: { ...balance.balanceTiers } },
    ]))
    const value = `SYNTHETIC_${name.replaceAll(' ', '_').toUpperCase()}`
    inject(body, key, value)
    rejectsWithoutEcho(
      JSON.stringify(body),
      '$ must not contain sensitive keys',
      [key, value],
    )
  })
}

for (const [name, row, message] of [
  ['balance currency type', { ...balance, currency: 7 }, '$.result.value.rows[*].currency must be a string'],
  ['balance tier type', { ...balance, balanceTiers: { critical: 10, warn: '20', healthy: 50 } }, '$.result.value.rows[*].balanceTiers values must be finite numbers'],
  ['usage window label type', { ...usage, windowLabels: { rolling: 1 } }, '$.result.value.rows[*].windowLabels values must be strings'],
  ['usage percent type', { ...usage, warnPercent: '70' }, '$.result.value.rows[*].warnPercent must be a finite number'],
]) {
  test(`validateSpecsResponse checks ${name}`, () => {
    rejectsWithoutEcho(response([row]), message)
  })
}

for (const [name, assignment] of [
  ['window property', 'window.__DSH_BOOT__'],
  ['globalThis bracket', 'globalThis["__DSH_BOOT__"]'],
]) {
  test(`bootPayloadFromHtml returns the parsed object from a real ${name} assignment`, () => {
    const payload = {
      rev: `graph-${name}`,
      plugins: [{ id: 'dsh-quota-panel', url: `/plugins/??dsh-quota-panel/client.js&rev=${name}` }],
    }
    const html = `<script>${assignment} = ${JSON.stringify(payload)};</script>`

    assert.deepEqual(bootPayloadFromHtml(html), payload)
    assert.equal(clientUrlFromBootHtml(html), payload.plugins[0].url)
  })
}

for (const [name, html, secret] of [
  ['invalid JSON', '<script>window.__DSH_BOOT__={"note":"SYNTHETIC_INVALID_JSON",}</script>', 'SYNTHETIC_INVALID_JSON'],
  ['an inert template', '<template><script>window.__DSH_BOOT__={"note":"SYNTHETIC_INERT_TEMPLATE"}</script></template>', 'SYNTHETIC_INERT_TEMPLATE'],
  ['duplicate assignments', '<script>window.__DSH_BOOT__={"note":"SYNTHETIC_DUPLICATE_ONE"}</script><script>globalThis["__DSH_BOOT__"]={"note":"SYNTHETIC_DUPLICATE_TWO"}</script>', 'SYNTHETIC_DUPLICATE'],
  ['a script src', '<script src="/SYNTHETIC_SRC.js">window.__DSH_BOOT__={"note":"SYNTHETIC_SRC_BODY"}</script>', 'SYNTHETIC_SRC'],
  ['a non-JavaScript MIME', '<script type="application/json">window.__DSH_BOOT__={"note":"SYNTHETIC_MIME"}</script>', 'SYNTHETIC_MIME'],
  ['a pseudo script tag', '< script>window.__DSH_BOOT__={"note":"SYNTHETIC_PSEUDO"}</script>', 'SYNTHETIC_PSEUDO'],
  ['an invalid JSON backslash escape', String.raw`<script>window.__DSH_BOOT__={"note":"SYNTHETIC_BACKSLASH\q"}</script>`, 'SYNTHETIC_BACKSLASH'],
]) {
  test(`bootPayloadFromHtml fails closed on ${name} without echoing input`, () => {
    assert.throws(
      () => bootPayloadFromHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must contain exactly one valid DSH boot payload')
        assert.doesNotMatch(error.message, new RegExp(secret))
        return true
      },
    )
  })
}

test('clientUrlFromBootHtml extracts the revisioned quota client URL and decodes ampersands', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"id":"other","url":"/plugins/??other/client.js&amp;rev=1"},{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&amp;rev=quota-42"}]}</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/??dsh-quota-panel/client.js&rev=quota-42',
  )
})

test('clientUrlFromBootHtml parses the real DSH globalThis bracket boot assignment', () => {
  const html = '<script>globalThis["__DSH_BOOT__"] = {"rev":"graph-1","plugins":[{"url":"/plugins/??dsh-quota-panel/client.js&rev=quota-real","platform":"web","enabled":true,"id":"dsh-quota-panel"}]}</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/??dsh-quota-panel/client.js&rev=quota-real',
  )
})

test('clientUrlFromBootHtml allows url before id and unrelated fields in the same object', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"url":"/plugins/??wrong/client.js&amp;rev=wrong","id":"other"},{"url":"/plugins/??dsh-quota-panel/client.js&amp;rev=quota-43","platform":"web","enabled":true,"id":"dsh-quota-panel"}]}</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/??dsh-quota-panel/client.js&rev=quota-43',
  )
})

test('clientUrlFromBootHtml accepts a plain quota client path with a revision query', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/dsh-quota-panel/client.js?rev=quota-plain"}]}</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/dsh-quota-panel/client.js?rev=quota-plain',
  )
})

// DSH 0.1.7 made app-owned browser routes document-relative: the boot graph
// advertises `plugins/??<id>/client.js&rev=<rev>` with no leading slash. The
// helper resolves that against the probed page origin and still hands the
// probe one absolute path, so the shell that curls `${origin}${path}` works
// on both host lines.
test('clientUrlFromBootHtml resolves the 0.1.7 document-relative combo reference to an absolute path', () => {
  const html = '<script>window.__DSH_BOOT__={"rev":"graph-1","entries":[{"id":"dsh-quota-panel","url":"plugins/??dsh-quota-panel/client.js&rev=quota-relative","rev":"quota-relative","inject":[]}]}</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/??dsh-quota-panel/client.js&rev=quota-relative',
  )
})

test('clientUrlFromBootHtml resolves the 0.1.7 document-relative plain client reference', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"plugins/dsh-quota-panel/client.js?rev=quota-relative-plain"}]}</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/dsh-quota-panel/client.js?rev=quota-relative-plain',
  )
})

for (const [name, url] of [
  ['an absolute scheme', 'https://evil.invalid/plugins/dsh-quota-panel/client.js?rev=SYNTHETIC_RELATIVE_SCHEME'],
  ['a protocol-relative authority', '//evil.invalid/plugins/dsh-quota-panel/client.js?rev=SYNTHETIC_RELATIVE_AUTHORITY'],
  ['a scheme-relative combo reference', '//evil.invalid/plugins/??dsh-quota-panel/client.js&rev=SYNTHETIC_RELATIVE_COMBO'],
]) {
  test(`clientUrlFromBootHtml rejects a document-relative URL smuggling ${name}`, () => {
    const html = `<script>window.__DSH_BOOT__=${JSON.stringify({ plugins: [{ id: 'dsh-quota-panel', url }] })}</script>`
    assert.throws(
      () => clientUrlFromBootHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
        assert.doesNotMatch(error.message, /evil|SYNTHETIC_RELATIVE/)
        return true
      },
    )
  })
}

test('clientUrlFromBootHtml rejects a backslash authority URL whose parsed origin is cross-origin', () => {
  const url = '/\\evil.invalid/plugins/dsh-quota-panel/client.js?rev=SYNTHETIC_CROSS_ORIGIN'
  assert.equal(new URL(url, 'http://127.0.0.1').origin, 'http://evil.invalid')
  const html = `<script>window.__DSH_BOOT__=${JSON.stringify({ plugins: [{ id: 'dsh-quota-panel', url }] })}</script>`
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /evil|SYNTHETIC_CROSS_ORIGIN/)
      return true
    },
  )
})

for (const [name, url] of [
  ['mixed slash authority', '/\\/evil.invalid/plugins/dsh-quota-panel/client.js?rev=SYNTHETIC_BACKSLASH_MIXED'],
  ['repeated backslash authority', '/\\\\evil.invalid/plugins/dsh-quota-panel/client.js?rev=SYNTHETIC_BACKSLASH_REPEATED'],
  ['backslash authority and path separators', '/\\evil.invalid\\plugins\\dsh-quota-panel\\client.js?rev=SYNTHETIC_BACKSLASH_NORMALIZED'],
  ['combo authority delimiter', '/\\evil.invalid/plugins/??dsh-quota-panel/client.js&rev=SYNTHETIC_BACKSLASH_COMBO'],
]) {
  test(`clientUrlFromBootHtml rejects cross-origin ${name} normalization without echoing the URL`, () => {
    assert.notEqual(new URL(url, 'http://127.0.0.1').origin, 'http://127.0.0.1')
    const html = `<script>window.__DSH_BOOT__=${JSON.stringify({ plugins: [{ id: 'dsh-quota-panel', url }] })}</script>`
    assert.throws(
      () => clientUrlFromBootHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
        assert.doesNotMatch(error.message, /evil|SYNTHETIC_BACKSLASH/i)
        return true
      },
    )
  })
}

test('clientUrlFromBootHtml rejects a same-origin path backslash before URL normalization', () => {
  const url = '/plugins\\dsh-quota-panel/client.js?rev=SYNTHETIC_BACKSLASH_PATH'
  assert.equal(new URL(url, 'http://127.0.0.1').origin, 'http://127.0.0.1')
  const html = `<script>window.__DSH_BOOT__=${JSON.stringify({ plugins: [{ id: 'dsh-quota-panel', url }] })}</script>`
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_BACKSLASH_PATH/)
      return true
    },
  )
})

test('clientUrlFromBootHtml rejects a revision found only in the URL fragment without echoing it', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/dsh-quota-panel/client.js?x=1#fragment?rev=SYNTHETIC_FRAGMENT_REV"}]}</script>'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_FRAGMENT_REV/)
      return true
    },
  )
})

test('clientUrlFromBootHtml rejects ampersand revision text embedded in a plain pathname', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/dsh-quota-panel/client.js&rev=SYNTHETIC_PATH_REV"}]}</script>'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_PATH_REV/)
      return true
    },
  )
})

for (const [name, url] of [
  ['combo path', '/plugins/??dsh-quota-panel/client.js&rev=quota-combo#fragment?rev=decoy'],
  ['plain path', '/plugins/dsh-quota-panel/client.js?x=1&rev=quota-plain#fragment'],
]) {
  test(`clientUrlFromBootHtml accepts a real revision in the ${name} request portion before a fragment`, () => {
    const html = `<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"${url}"}]}</script>`
    assert.equal(clientUrlFromBootHtml(html), url)
  })
}

test('clientUrlFromBootHtml parses nested boot JSON and braces inside strings', () => {
  const html = '<script>window.__DSH_BOOT__ = {"meta":{"note":"literal { braces } and \\"quoted\\" text"},"plugins":[{"url":"/plugins/??dsh-quota-panel/client.js&amp;rev=quota-44","details":{"nested":{"enabled":true}},"id":"dsh-quota-panel"}]};</script>'
  assert.equal(
    clientUrlFromBootHtml(html),
    '/plugins/??dsh-quota-panel/client.js&rev=quota-44',
  )
})

test('clientUrlFromBootHtml rejects a script found only inside an HTML comment without echoing it', () => {
  const html = '<!-- <script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=SYNTHETIC_COMMENT_REV"}]}</script> -->'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_COMMENT_REV/)
      return true
    },
  )
})

test('clientUrlFromBootHtml rejects a script nested inside quoted and nested templates without echoing it', () => {
  const html = '<template data-note="quoted > value"><section><TeMpLaTe id=\'nested\'><ScRiPt>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=SYNTHETIC_TEMPLATE_REV"}]}</sCrIpT></tEmPlAtE></section></template>'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_TEMPLATE_REV/)
      return true
    },
  )
})

for (const [name, opening] of [
  ['space', '< script>'],
  ['tab', '<\tscript>'],
]) {
  test(`clientUrlFromBootHtml does not execute a script pseudo-tag with ${name} after less-than`, () => {
    const rev = `SYNTHETIC_PSEUDO_OPEN_${name.toUpperCase()}`
    const html = `${opening}window.__DSH_BOOT__=${JSON.stringify({ plugins: [{ id: 'dsh-quota-panel', url: `/plugins/??dsh-quota-panel/client.js&rev=${rev}` }] })}</script>`
    assert.throws(
      () => clientUrlFromBootHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
        assert.doesNotMatch(error.message, /SYNTHETIC_PSEUDO_OPEN/)
        return true
      },
    )
  })
}

for (const [name, closing] of [
  ['space', '</ template>'],
  ['tab', '</\ttemplate>'],
]) {
  test(`clientUrlFromBootHtml keeps scripts inert after a template pseudo-close with ${name} after slash`, () => {
    const rev = `SYNTHETIC_PSEUDO_CLOSE_${name.toUpperCase()}`
    const html = `<template data-note="quoted > value">${closing}<ScRiPt nonce="quoted > value">window.__DSH_BOOT__=${JSON.stringify({ plugins: [{ id: 'dsh-quota-panel', url: `/plugins/??dsh-quota-panel/client.js&rev=${rev}` }] })}</sCrIpT></template>`
    assert.throws(
      () => clientUrlFromBootHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
        assert.doesNotMatch(error.message, /SYNTHETIC_PSEUDO_CLOSE/)
        return true
      },
    )
  })
}

test('clientUrlFromBootHtml accepts adjacent mixed-case tags with post-name whitespace and quoted greater-than attributes', () => {
  const html = '<TeMpLaTe data-note="quoted > value"></tEmPlAtE \t><ScRiPt\tnonce="quoted > value" type="text/javascript" >window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=adjacent-valid"}]}</sCrIpT \t>'
  assert.equal(clientUrlFromBootHtml(html), '/plugins/??dsh-quota-panel/client.js&rev=adjacent-valid')
})

test('clientUrlFromBootHtml ignores comment and template decoys when one executable assignment exists', () => {
  const html = '<!-- <script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=comment-decoy"}]}</script> --><template data-note="quoted > value"><template><script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=template-decoy"}]}</script></template></template><script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=executable"}]}</script>'
  assert.equal(clientUrlFromBootHtml(html), '/plugins/??dsh-quota-panel/client.js&rev=executable')
})

test('clientUrlFromBootHtml does not treat HTML comment markers inside executable script JSON as markup', () => {
  const html = '<script>window.__DSH_BOOT__={"meta":{"note":"literal <!-- marker --> text"},"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=comment-string"}]}</script>'
  assert.equal(clientUrlFromBootHtml(html), '/plugins/??dsh-quota-panel/client.js&rev=comment-string')
})

for (const [name, html] of [
  [
    'duplicate assignments',
    '<script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=first"}]}</script><script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=second"}]}</script>',
  ],
  [
    'a string decoy before a valid assignment',
    '<script>const decoy = "window.__DSH_BOOT__={}"</script><script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=real"}]}</script>',
  ],
  [
    'a malformed anchored assignment before a valid assignment',
    '<script>window.__DSH_BOOT__={"plugins":[}</script><script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=real"}]}</script>',
  ],
  [
    'extra script statements around the assignment',
    '<script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=real"}]};globalThis.extra=true</script>',
  ],
  [
    'a non-executable application/json script',
    '<script type="application/json">globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=real"}]}</script>',
  ],
  [
    'a non-executable text/plain script',
    '<script nonce="safe" type="text/plain">globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=real"}]}</script>',
  ],
  [
    'an unquoted non-executable script type',
    '<script type=application/json>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=real"}]}</script>',
  ],
  [
    'duplicate quota plugin ids',
    '<script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=one"},{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=two"}]}</script>',
  ],
  [
    'a valid quota client plus a duplicate invalid quota id',
    '<script>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=one"},{"id":"dsh-quota-panel","url":"/plugins/??other/client.js&rev=two"}]}</script>',
  ],
]) {
  test(`clientUrlFromBootHtml fails closed on ${name}`, () => {
    assert.throws(
      () => clientUrlFromBootHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
        assert.doesNotMatch(error.message, /first|second|real/)
        return true
      },
    )
  })
}

for (const [name, attributes] of [
  ['double-quoted src', 'src="/external.js"'],
  ['single-quoted src', "src='/external.js'"],
  ['unquoted src', 'src=/external.js'],
  ['ASCII-case-insensitive src', 'SrC = "/external.js"'],
  ['tab-spaced src', 'nonce="safe"\tSRC\t=\t/external.js defer'],
]) {
  test(`clientUrlFromBootHtml rejects inline boot body on script with ${name}`, () => {
    const html = `<script ${attributes}>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=SYNTHETIC_SRC_REV"}]}</script>`
    assert.throws(
      () => clientUrlFromBootHtml(html),
      error => {
        assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
        assert.doesNotMatch(error.message, /external|SYNTHETIC_SRC_REV/)
        return true
      },
    )
  })
}

for (const [name, attributes, rev] of [
  ['data-src', 'data-src="/metadata.js"', 'data-src'],
  ['srcdoc', 'srcdoc="metadata"', 'srcdoc'],
  ['nonce/defer/async', 'nonce="safe" defer async', 'flags'],
  ['double-quoted data attribute value containing src', 'data-note="safe src marker"', 'data-value-src'],
  ['single-quoted title value containing src', "title='safe src marker'", 'title-value-src'],
  ['nonce value containing src', 'nonce="safe src marker" defer', 'nonce-value-src'],
]) {
  test(`clientUrlFromBootHtml does not confuse ${name} with exact src`, () => {
    const html = `<script ${attributes}>globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=${rev}"}]}</script>`
    assert.equal(clientUrlFromBootHtml(html), `/plugins/??dsh-quota-panel/client.js&rev=${rev}`)
  })
}

test('clientUrlFromBootHtml preserves first duplicate type when non-executable comes first', () => {
  const html = '<script type="application/json" TYPE="module">globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=SYNTHETIC_DUPLICATE_TYPE"}]}</script>'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_DUPLICATE_TYPE/)
      return true
    },
  )
})

test('clientUrlFromBootHtml preserves first duplicate type when executable comes first', () => {
  const html = '<script TYPE="module" type="application/json">globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=first-type"}]}</script>'
  assert.equal(clientUrlFromBootHtml(html), '/plugins/??dsh-quota-panel/client.js&rev=first-type')
})

test('clientUrlFromBootHtml accepts an executable script with nonce and JavaScript MIME', () => {
  const html = '<script nonce="safe" defer type="text/javascript">globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=typed"}]}</script>'
  assert.equal(clientUrlFromBootHtml(html), '/plugins/??dsh-quota-panel/client.js&rev=typed')
})

test('clientUrlFromBootHtml accepts an executable module script', () => {
  const html = '<script type="module">globalThis["__DSH_BOOT__"]={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??dsh-quota-panel/client.js&rev=module"}]}</script>'
  assert.equal(clientUrlFromBootHtml(html), '/plugins/??dsh-quota-panel/client.js&rev=module')
})

test('clientUrlFromBootHtml rejects a quota record pointing at another plugin without echoing HTML', () => {
  const html = '<script>window.__DSH_BOOT__={"plugins":[{"id":"dsh-quota-panel","url":"/plugins/??other/client.js&amp;rev=SYNTHETIC_BAD_REV"}]}</script>'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /other|SYNTHETIC_BAD_REV/)
      return true
    },
  )
})

test('clientUrlFromBootHtml preserves its fixed non-string input diagnostic without echoing values', () => {
  const input = { secret: 'SYNTHETIC_NON_STRING_BOOT_SECRET' }
  assert.throws(
    () => clientUrlFromBootHtml(input),
    error => {
      assert.equal(error.message, 'boot HTML must be a string')
      assert.doesNotMatch(error.message, /SYNTHETIC_NON_STRING_BOOT_SECRET/)
      return true
    },
  )
})

test('clientUrlFromBootHtml rejects a missing quota client URL without echoing HTML', () => {
  const html = '<html>SYNTHETIC_BOOT_CONTENT</html>'
  assert.throws(
    () => clientUrlFromBootHtml(html),
    error => {
      assert.equal(error.message, 'boot HTML must advertise a revisioned dsh-quota-panel client URL')
      assert.doesNotMatch(error.message, /SYNTHETIC_BOOT_CONTENT/)
      return true
    },
  )
})

test('redactLog redacts token values without changing unrelated log text', () => {
  const input = 'open http://127.0.0.1:3080/?token=synthetic_one-1&next=ok\nTOKEN=synthetic.two next token = synthetic_three\nsafe=1'
  assert.equal(
    redactLog(input),
    'open http://127.0.0.1:3080/?token=[REDACTED]&next=ok\nTOKEN=[REDACTED] next token = [REDACTED]\nsafe=1',
  )
})
