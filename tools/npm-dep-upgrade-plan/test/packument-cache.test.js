import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createPackumentCache } from '../src/packument-cache.js'

const key = 'corgi:https://registry.example/pkg'
const packument = { name: 'pkg', versions: { '1.0.0': { name: 'pkg', version: '1.0.0' } } }

async function fixture(t) {
  const dir = join(await mkdtemp(join(tmpdir(), 'packument-cache-')), 'packuments')
  t.after(() => rm(join(dir, '..'), { recursive: true, force: true }))
  let current = 1000
  const open = (overrides = {}) => createPackumentCache({ dir, identity: 'id-a', ttlMs: 100, now: () => current, ...overrides })
  const files = () => (existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [])
  const time = (value) => {
    current = value
  }
  return { dir, open, files, time }
}

test('memory-only cache shares within an instance but not across instances', async (t) => {
  const f = await fixture(t)
  const first = createPackumentCache({ dir: null, identity: 'id-a', ttlMs: 100 })
  first.set(key, packument)
  assert.equal(first.has(key), true)
  assert.equal(first.get(key), packument)
  assert.equal(createPackumentCache({ dir: null, identity: 'id-a', ttlMs: 100 }).has(key), false)
  assert.deepEqual(f.files(), [])
})

test('disk entry is served to another instance with its original fetchedAt', async (t) => {
  const f = await fixture(t)
  f.open().set(key, packument)
  f.time(1050)
  const other = f.open()
  assert.equal(other.has(key), true)
  assert.deepEqual(other.get(key), packument)
  assert.equal(other.oldestFetchedAt, 1000)
  assert.equal(other.stats.diskHits, 1)
  assert.equal(f.open().oldestFetchedAt, Infinity)
})

test('reuse never extends age', async (t) => {
  const f = await fixture(t)
  f.open().set(key, packument)
  f.time(1099)
  assert.equal(f.open().has(key), true)
  f.time(1100)
  const late = f.open()
  assert.equal(late.has(key), false)
  assert.equal(late.stats.misses, 1)
  assert.deepEqual(f.files(), [])
})

test('clock rollback is a miss', async (t) => {
  const f = await fixture(t)
  f.open().set(key, packument)
  f.time(999)
  assert.equal(f.open().has(key), false)
})

test('identity and key isolate entries', async (t) => {
  const f = await fixture(t)
  f.open().set(key, packument)
  assert.equal(f.open({ identity: 'id-b' }).has(key), false)
  assert.equal(f.open().has('full:https://registry.example/pkg'), false)
  assert.equal(f.open().has(key), true)
})

test('entry files hold no key, URL or credentials', async (t) => {
  const f = await fixture(t)
  f.open().set('corgi:https://user:secret@registry.example/pkg', packument)
  const [file] = f.files()
  assert.match(file, /[0-9a-f]{64}\.json\.gz$/)
  const text = gunzipSync(readFileSync(file)).toString()
  assert.doesNotMatch(text, /secret|registry\.example/)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(f.dir).mode & 0o777, 0o700)
  }
})

test('corrupt or truncated entries are misses', async (t) => {
  const f = await fixture(t)
  f.open().set(key, packument)
  const [file] = f.files()
  const valid = readFileSync(file)
  writeFileSync(file, Buffer.from('garbage'))
  assert.equal(f.open().has(key), false)
  f.open().set(key, packument)
  writeFileSync(file, valid.subarray(0, 10))
  assert.equal(f.open().has(key), false)
})

test('checksum mismatch is a miss', async (t) => {
  const f = await fixture(t)
  f.open().set(key, packument)
  const [file] = f.files()
  const entry = JSON.parse(gunzipSync(readFileSync(file)).toString())
  entry.packument = { ...entry.packument, name: 'tampered' }
  writeFileSync(file, gzipSync(JSON.stringify(entry)))
  assert.equal(f.open().has(key), false)
})

test('delete drops memory and disk', async (t) => {
  const f = await fixture(t)
  const cache = f.open()
  cache.set(key, packument)
  cache.delete(key)
  assert.equal(cache.has(key), false)
  assert.equal(f.open().has(key), false)
})

test('unwritable directory is nonfatal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'packument-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'blocker'), 'not a directory')
  const cache = createPackumentCache({ dir: join(root, 'blocker', 'packuments'), identity: 'id-a', ttlMs: 100 })
  assert.doesNotThrow(() => cache.set(key, packument))
  assert.equal(cache.has(key), true)
  assert.equal(cache.get(key), packument)
})
