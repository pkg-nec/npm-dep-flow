import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchCatalog } from '../src/registry.js'

test('fetches both fields in one command with original fetch time and cwd', async () => {
  const calls = []
  const report = await fetchCatalog('/project with spaces', '@scope/pkg', { now: () => 1000, run: async (...args) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ versions: ['1.0.0'], time: {} }) }
  } })
  assert.deepEqual(calls, [['npm', ['view', '@scope/pkg', 'versions', 'time', '--json'], '/project with spaces']])
  assert.deepEqual(report, { schemaVersion: 2, package: '@scope/pkg', fetchedAt: '1970-01-01T00:00:01.000Z', rows: [{ version: '1.0.0', releasedAt: null }] })
})
test('fails without leaking output or attempting fallback queries', async () => {
  for (const response of [{ code: 1, stdout: '', stderr: 'SECRET' }, { code: 0, stdout: '' }, { code: 0, stdout: '{SECRET' }, { code: 0, stdout: '{}' }]) {
    let calls = 0
    await assert.rejects(fetchCatalog('/p', 'pkg', { run: async () => {
      calls++
      return response
    } }), e => !e.message.includes('SECRET'))
    assert.equal(calls, 1)
  }
  await assert.rejects(fetchCatalog('/p', 'pkg', { run: async () => {
    throw Object.assign(new Error('SECRET'), { code: 'ENOENT' })
  } }), /npm.*PATH/)
})
test('rejects unsafe package names before spawning on every platform', async () => {
  for (const name of ['pkg;echo', 'pkg@1', 'https://example.test/pkg', '@scope/pkg&bad', '']) await assert.rejects(fetchCatalog('/p', name, { run: () => assert.fail('must not launch') }), /package/i)
})
