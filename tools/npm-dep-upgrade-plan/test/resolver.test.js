import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveChoices } from '../src/resolver.js'

test('rejects malformed worker evidence rather than claiming coverage', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'resolver-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(['package.json', 'package-lock.json'].map(n => writeFile(path.join(root, n), '{}')))
  const options = { readRuntime: async () => ({ npmPath: root }), run: async () => ({ code: 0, stdout: '{}' }) }
  await assert.rejects(resolveChoices({ root }, {}, [], options), /Invalid resolver evidence/)
  options.run = async () => ({ code: 1, stdout: '', stderr: 'credential-sensitive text' })
  await assert.rejects(resolveChoices({ root }, {}, [], options), error => error.message === 'Dependency resolver failed')
})

async function capturedRequest(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), 'resolver-request-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(['package.json', 'package-lock.json'].map(n => writeFile(path.join(root, n), '{}')))
  let request
  await resolveChoices({ root }, {}, [], {
    readRuntime: async () => ({ npmPath: root }),
    run: async (args) => {
      request = JSON.parse(readFileSync(args[1], 'utf8'))
      return { code: 0, stdout: JSON.stringify({ schemaVersion: 1, choices: [], coverage: { resolution: 'none' }, graph: { nodes: [] }, freshAt: 1 }) }
    },
    ...options,
  })
  return request
}

test('request carries the packument cache under the planner cache root', async (t) => {
  const base = { env: { XDG_CACHE_HOME: '/x' }, ttlMs: 5000 }
  const request = await capturedRequest(t, { ...base, packumentIdentity: { a: 1 } })
  assert.equal(request.packumentCache.dir, path.join('/x', 'npm-dep-upgrade-plan', 'packuments'))
  assert.equal(request.packumentCache.ttlMs, 5000)
  assert.match(request.packumentCache.identity, /^[0-9a-f]{64}$/)
  assert.equal((await capturedRequest(t, { ...base, packumentIdentity: { a: 1 } })).packumentCache.identity, request.packumentCache.identity)
  assert.notEqual((await capturedRequest(t, { ...base, packumentIdentity: { a: 2 } })).packumentCache.identity, request.packumentCache.identity)
})

test('no-cache and missing identity disable the disk cache', async (t) => {
  assert.equal((await capturedRequest(t, { ttlMs: 5000, noCache: true, packumentIdentity: { a: 1 } })).packumentCache, null)
  assert.equal((await capturedRequest(t, { ttlMs: 5000 })).packumentCache, null)
})
