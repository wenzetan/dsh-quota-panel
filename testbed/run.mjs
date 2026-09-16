#!/usr/bin/env node
// Canonical testbed launcher. Local direct runs default to China; CI keeps using
// compose.yaml directly or selects --network global explicitly.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const globalCompose = join(here, 'compose.yaml')
const chinaCompose = join(here, 'compose.china.yaml')
const argv = process.argv.slice(2)

function usage(message) {
  if (message) console.error(`[testbed-network] ${message}`)
  console.error('usage: node testbed/run.mjs [--network global|china] [docker compose arguments]')
  process.exit(2)
}

let network = 'china'
const dockerArgs = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--network') {
    const value = argv[index + 1]
    if (!value) usage('--network requires global|china')
    network = value
    index += 1
    continue
  }
  if (arg.startsWith('--network=')) {
    network = arg.slice('--network='.length)
    continue
  }
  dockerArgs.push(arg)
}

if (network !== 'global' && network !== 'china') usage(`invalid network ${network}; expected global|china`)
if (dockerArgs.length === 0) dockerArgs.push('run', '--rm', '--build', 'testbed')

const composeFiles = network === 'china'
  ? [globalCompose, chinaCompose]
  : [globalCompose]
const composeArgs = ['compose']
for (const file of composeFiles) composeArgs.push('-f', file)
composeArgs.push(...dockerArgs)

console.log(`[testbed-network] network=${network}`)
console.log(`[testbed-network] compose files: ${composeFiles.join(' + ')}`)

const env = { ...process.env }
if (!env.DOCKER_CONFIG) {
  env.DOCKER_CONFIG = join(here, '.docker-config')
  mkdirSync(env.DOCKER_CONFIG, { recursive: true })
}

const result = spawnSync('docker', composeArgs, {
  cwd: here,
  env,
  stdio: 'inherit',
})
if (result.error) {
  console.error(`[testbed-network] failed to start docker: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  console.error(`[testbed-network] docker terminated by ${result.signal}`)
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)
