import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cachedResult } from '../src/result-cache.js'

async function fixture(t) {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'result-cache-'))
  t.after(() => rm(cacheRoot, { recursive: true, force: true }))
  let current = 1000
  let calls = 0
  const options = { tool: 'fixture', version: '1', project: { root: '/project', manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') }, cacheRoot, now: () => current, ttlMs: 100 }
  const compute = async () => ({ value: { generation: ++calls }, expiresAt: 1100 })
  return {
    options, compute,
    get calls() { return calls },
    time(value) { current = value },
    async file() { return join(cacheRoot, (await readdir(cacheRoot))[0]) },
  }
}

test('result cache respects TTL, upstream expiry, shorter requested TTL and clock rollback', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await cachedResult(f.options, f.compute), { generation: 1 })
  f.time(1099)
  assert.deepEqual(await cachedResult(f.options, f.compute), { generation: 1 })
  assert.deepEqual(await cachedResult({ ...f.options, ttlMs: 50 }, f.compute), { generation: 2 })
  f.time(1100)
  assert.deepEqual(await cachedResult({ ...f.options, ttlMs: 1000 }, f.compute), { generation: 3 })
  f.time(999)
  assert.deepEqual(await cachedResult(f.options, f.compute), { generation: 4 })
})

test('result cache isolates versions, identities, queries and both dependency files', async (t) => {
  const f = await fixture(t)
  await cachedResult(f.options, f.compute)
  for (const change of [
    { version: '2' }, { identity: 'other executable or registry' }, { query: ['other'] },
    { project: { ...f.options.project, manifestBytes: Buffer.from('{"name":"changed"}') } },
    { project: { ...f.options.project, lockBytes: Buffer.from('{"packages":{}}') } },
    { project: { ...f.options.project, root: '/different-project' } },
  ]) {
    const before = f.calls
    await cachedResult({ ...f.options, ...change }, f.compute)
    assert.equal(f.calls, before + 1)
    // Restore a base entry so each invalidation is tested independently.
    await cachedResult(f.options, f.compute)
  }
})

test('bypass never reads or writes and failed refresh does not serve stale data', async (t) => {
  const f = await fixture(t)
  await cachedResult(f.options, f.compute)
  const before = await readFile(await f.file(), 'utf8')
  assert.deepEqual(await cachedResult({ ...f.options, noCache: true }, f.compute), { generation: 2 })
  assert.equal(await readFile(await f.file(), 'utf8'), before)
  f.time(1100)
  await assert.rejects(cachedResult(f.options, async () => {
    throw new Error('refresh failed')
  }), /refresh failed/)
  assert.equal(await readFile(await f.file(), 'utf8'), before)
})

test('corrupt entries are misses and unavailable storage does not prevent reports', async (t) => {
  const f = await fixture(t)
  await cachedResult(f.options, f.compute)
  for (const value of ['{', 'null', '{"key":"wrong"}']) {
    await writeFile(await f.file(), value)
    const before = f.calls
    await cachedResult(f.options, f.compute)
    assert.equal(f.calls, before + 1)
  }
  const file = await f.file()
  const entry = JSON.parse(await readFile(file, 'utf8'))
  entry.value.generation = 999
  await writeFile(file, JSON.stringify(entry))
  assert.notEqual((await cachedResult(f.options, f.compute)).generation, 999)
  const blockedRoot = join(f.options.cacheRoot, 'regular-file')
  await writeFile(blockedRoot, '')
  const before = f.calls
  assert.deepEqual(await cachedResult({ ...f.options, cacheRoot: blockedRoot }, f.compute), { generation: before + 1 })
})

test('a shorter requested TTL is measured from source freshness, not result creation', async (t) => {
  const f = await fixture(t)
  const compute = async () => ({ value: { generation: ++generation }, freshAt: 0, expiresAt: 2000 })
  let generation = 0
  assert.deepEqual(await cachedResult({ ...f.options, ttlMs: 2000 }, compute), { generation: 1 })
  assert.deepEqual(await cachedResult({ ...f.options, ttlMs: 500 }, compute), { generation: 2 })
})
