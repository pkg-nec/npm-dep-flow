import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getAudit } from '../src/cache.js'

const audit = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }
const context = { version: '12.1.0', registry: 'https://registry.npmjs.org/' }
const project = { root: '/project', manifestBytes: Buffer.from('{"name":"one"}'), lockBytes: Buffer.from('{"lockfileVersion":3}') }

async function cacheDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-dep-audit-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('cache reuses a fresh audit and refetches after expiry', async t => {
  const cacheRoot = await cacheDir(t)
  let calls = 0
  let current = 1000000
  const options = { ttlMs: 3600000, cacheRoot, now: () => current, fetchAudit: async () => { calls++; return audit } }
  const first = await getAudit(project, context, options)
  current += 3599999
  const second = await getAudit(project, context, options)
  assert.equal(calls, 1)
  assert.deepEqual(second, first)
  current++
  const third = await getAudit(project, context, options)
  assert.equal(calls, 2)
  assert.equal(third.auditedAt, new Date(current).toISOString())
})

test('manifest, lockfile, npm version, and registry changes each invalidate cache', async t => {
  const cacheRoot = await cacheDir(t)
  let calls = 0
  const options = { ttlMs: 3600000, cacheRoot, now: () => 1000000, fetchAudit: async () => { calls++; return audit } }
  await getAudit(project, context, options)
  await getAudit({ ...project, manifestBytes: Buffer.from('{"name":"two"}') }, context, options)
  await getAudit({ ...project, lockBytes: Buffer.from('{"lockfileVersion":2}') }, context, options)
  await getAudit(project, { ...context, version: '12.2.0' }, options)
  await getAudit(project, { ...context, registry: 'https://other.example/' }, options)
  assert.equal(calls, 5)
})

test('no-cache bypasses reads and writes', async t => {
  const cacheRoot = await cacheDir(t)
  let calls = 0
  const options = { ttlMs: 3600000, cacheRoot, noCache: true, now: () => 1000000, fetchAudit: async () => { calls++; return audit } }
  await getAudit(project, context, options)
  await getAudit(project, context, options)
  assert.equal(calls, 2)
  assert.deepEqual(await readdir(cacheRoot), [])
})

test('truncated cache is a miss and replacement is complete JSON', async t => {
  const cacheRoot = await cacheDir(t)
  let calls = 0
  const options = { ttlMs: 3600000, cacheRoot, now: () => 1000000, fetchAudit: async () => { calls++; return audit } }
  await getAudit(project, context, options)
  const [name] = await readdir(cacheRoot)
  await writeFile(join(cacheRoot, name), '{')
  await getAudit(project, context, options)
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(await readFile(join(cacheRoot, name), 'utf8')).audit, audit)
  assert.deepEqual(await readdir(cacheRoot), [name])
})

test('failed refresh does not serve stale data or write an entry', async t => {
  const cacheRoot = await cacheDir(t)
  await assert.rejects(getAudit(project, context, { ttlMs: 3600000, cacheRoot, now: () => 1000000, fetchAudit: async () => { throw new Error('audit failed') } }), /audit failed/)
  assert.deepEqual(await readdir(cacheRoot), [])
  await getAudit(project, context, { ttlMs: 3600000, cacheRoot, now: () => 1000000, fetchAudit: async () => audit })
  await assert.rejects(getAudit(project, context, { ttlMs: 3600000, cacheRoot, now: () => 4600000, fetchAudit: async () => { throw new Error('audit failed') } }), /audit failed/)
})

test('does not cache malformed nested advisories', async t => {
  const cacheRoot = await cacheDir(t)
  const malformed = { ...audit, vulnerabilities: { dep: { via: [{ source: 1, severity: 'high', range: 'not a range' }], nodes: ['node_modules/dep'] } } }
  await assert.rejects(getAudit(project, context, { ttlMs: 3600000, cacheRoot, now: () => 1000000, fetchAudit: async () => malformed }), /audit|range/i)
  assert.deepEqual(await readdir(cacheRoot), [])
})

test('null cache envelope triggers a fresh audit', async t => {
  const cacheRoot = await cacheDir(t)
  let calls = 0
  const options = { ttlMs: 3600000, cacheRoot, now: () => 1000000, fetchAudit: async () => { calls++; return audit } }
  await getAudit(project, context, options)
  const [name] = await readdir(cacheRoot)
  await writeFile(join(cacheRoot, name), 'null')
  await getAudit(project, context, options)
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(await readFile(join(cacheRoot, name), 'utf8')).audit, audit)
})
