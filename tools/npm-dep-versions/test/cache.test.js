import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { cachedCatalog } from '../src/cache.js'
import { scratch } from './helpers/commands.js'

async function fixture(t) {
  const cacheRoot = await scratch(t)
  let now = 1000, calls = 0
  const options = { version: '1', root: '/p', packageName: 'pkg', identity: { npmVersion: '12', configHash: 'digest' }, cacheRoot, ttlMs: 100, now: () => now }
  const compute = async () => {
    calls++
    return { schemaVersion: 2, package: 'pkg', fetchedAt: new Date(now).toISOString(), rows: [{ version: '1.0.0', releasedAt: null }] }
  }
  const time = (n) => {
    now = n
  }
  return { options, compute, time, calls: () => calls, file: async () => join(cacheRoot, (await readdir(cacheRoot)).find(n => n.startsWith('catalog-'))) }
}

test('catalog TTL is measured from original fetch and bypass leaves old bytes untouched', async (t) => {
  const f = await fixture(t)
  const first = await cachedCatalog(f.options, f.compute)
  f.time(1099)
  assert.deepEqual(await cachedCatalog(f.options, f.compute), first)
  assert.equal(f.calls(), 1)
  f.time(1050)
  await cachedCatalog({ ...f.options, ttlMs: 50 }, f.compute)
  assert.equal(f.calls(), 2)
  f.time(1150)
  await cachedCatalog(f.options, f.compute)
  assert.equal(f.calls(), 3)
  const bytes = await readFile(await f.file(), 'utf8')
  await cachedCatalog({ ...f.options, noCache: true }, f.compute)
  assert.equal(await readFile(await f.file(), 'utf8'), bytes)
  f.time(1300)
  await assert.rejects(cachedCatalog(f.options, async () => {
    throw new Error('refresh failed')
  }), /refresh failed/)
})
test('cache isolates identities and rejects corrupt, tampered and future entries', async (t) => {
  const f = await fixture(t)
  await cachedCatalog(f.options, f.compute)
  const file = await f.file()
  for (const change of [{ version: '2' }, { root: '/other' }, { identity: { npmVersion: '11', configHash: 'digest' } }, { identity: { npmVersion: '12', configHash: 'changed' } }]) {
    const before = f.calls()
    await cachedCatalog({ ...f.options, ...change }, f.compute)
    assert.equal(f.calls(), before + 1)
  }
  await cachedCatalog(f.options, f.compute)
  for (const contents of ['{', 'null', '{"rows":[]}']) {
    await writeFile(file, contents)
    const before = f.calls()
    await cachedCatalog(f.options, f.compute)
    assert.equal(f.calls(), before + 1)
  }
  const entry = JSON.parse(await readFile(file, 'utf8'))
  entry.value.rows[0].version = '9.0.0'
  await writeFile(file, JSON.stringify(entry))
  assert.equal((await cachedCatalog(f.options, f.compute)).rows[0].version, '1.0.0')
  f.time(999)
  const before = f.calls()
  await cachedCatalog(f.options, f.compute)
  assert.equal(f.calls(), before + 1)
})
test('concurrent writes remain atomic and unavailable storage is nonfatal', async (t) => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: 8 }, () => cachedCatalog(f.options, f.compute)))
  assert.equal(JSON.parse(await readFile(await f.file(), 'utf8')).value.package, 'pkg')
  assert.equal((await readdir(f.options.cacheRoot)).some(n => n.endsWith('.tmp')), false)
  const blocked = join(f.options.cacheRoot, 'file')
  await writeFile(blocked, '')
  assert.equal((await cachedCatalog({ ...f.options, cacheRoot: blocked }, f.compute)).package, 'pkg')
})
