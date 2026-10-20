import test from 'node:test'
import assert from 'node:assert/strict'
import { readPlanningContext } from '../src/context.js'

function runner(config, versions = {}) {
  return async (command, args) => ({ code: 0, stdout: command === 'npm'
    ? args[0] === '--version' ? '12.1.0' : JSON.stringify(config)
    : `${command} v${versions[command] || '1.0.0'}\nLocation: /tools/${command}` })
}

test('effective scoped registry and tool changes invalidate identity without persisting secrets', async () => {
  const initial = await readPlanningContext('/project', runner({ registry: 'https://registry.example/', _auth: 'secret-token' }))
  const scoped = await readPlanningContext('/project', runner({ 'registry': 'https://registry.example/', '_auth': 'secret-token', '@scope:registry': 'https://scoped.example/' }))
  assert.notEqual(initial.configHash, scoped.configHash)
  const changed = await readPlanningContext('/project', runner({ registry: 'https://registry.example/', _auth: 'secret-token' }, { 'npm-dep-audit': '2.0.0' }))
  assert.notDeepEqual(initial, changed)
  assert.equal(JSON.stringify(initial).includes('secret-token'), false)
  const reordered = await readPlanningContext('/project', runner({ _auth: 'secret-token', registry: 'https://registry.example/' }))
  assert.deepEqual(initial, reordered)
})

test('context rejects failed commands and malformed configuration without exposing output', async () => {
  await assert.rejects(readPlanningContext('/project', async () => ({ code: 1, stdout: '', stderr: 'private credentials' })), /cache context/)
  const valid = runner({})
  for (const response of ['null', '[]', 'secret-token invalid json']) {
    await assert.rejects(readPlanningContext('/project', (command, args) => command === 'npm' && args[0] === 'config'
      ? Promise.resolve({ code: 0, stdout: response })
      : valid(command, args)), error => /Invalid npm configuration/.test(error.message) && !error.message.includes('secret-token'))
  }
})

test('npm release-age derived before timestamps do not invalidate analysis metadata', async () => {
  const config = { 'registry': 'https://registry.example/', 'min-release-age': null, 'before': '2026-10-13T11:00:00.000Z' }
  const first = await readPlanningContext('/project', runner(config))
  const second = await readPlanningContext('/project', runner({ ...config, before: '2026-10-13T11:00:00.100Z' }))
  assert.deepEqual(first, second)
  const registryChanged = await readPlanningContext('/project', runner({ ...config, registry: 'https://other.example/' }))
  assert.notEqual(first.configHash, registryChanged.configHash)
})
