import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { addIgnores, cacheRoot, isIgnored, readIgnores, storePath } from '../src/ignores.js'

async function withRoot(run) {
  const base = await mkdtemp(join(tmpdir(), 'autopilot-ignores-'))
  try {
    await run(join(base, 'cache'))
  }
  finally {
    await rm(base, { recursive: true, force: true })
  }
}

const repo = resolve('/srv/repo-a')
const at = new Date('2026-11-13T10:00:00.000Z')
const now = () => at
const ID1 = 'a1b2c3d'
const ID2 = '0d1e2f3'

test('storePath names the file by a 64-hex digest of the resolved repo path', () => {
  const root = resolve('/cache')
  assert.match(storePath('/srv/repo-a', root), /ignored-[0-9a-f]{64}\.json$/)
  assert.notEqual(storePath('/srv/repo-a', root), storePath('/srv/repo-b', root))
  assert.equal(storePath('/srv/repo-a', root), storePath('/srv/repo-a', root))
})

test('cacheRoot honours XDG_CACHE_HOME and falls back to the home directory', () => {
  assert.equal(cacheRoot({ XDG_CACHE_HOME: '/x' }), join('/x', 'npm-dep-autopilot'))
  assert.equal(cacheRoot({ HOME: '/h' }), join('/h', '.cache', 'npm-dep-autopilot'))
})

test('reading a missing store yields no entries and is not unreadable', async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await readIgnores(repo, root), { entries: [], unreadable: false })
  })
})

test('addIgnores creates the cache directory and writes version, repo and entries', async () => {
  await withRoot(async (root) => {
    const result = await addIgnores(repo, [{ module: 'web', id: ID1 }], root, now)
    assert.deepEqual(result, { added: [{ module: 'web', id: ID1 }], duplicates: [], rebuilt: false })
    assert.deepEqual(JSON.parse(await readFile(storePath(repo, root), 'utf8')), {
      version: 1,
      repo,
      entries: [{ module: 'web', id: ID1, addedAt: at.toISOString() }],
    })
  })
})

test('addIgnores appends to an existing store and reports duplicates', async () => {
  await withRoot(async (root) => {
    await addIgnores(repo, [{ module: 'web', id: ID1 }], root, now)
    const result = await addIgnores(repo, [{ module: 'web', id: ID1 }, { module: 'api', id: ID2 }], root, now)
    assert.deepEqual(result.added, [{ module: 'api', id: ID2 }])
    assert.deepEqual(result.duplicates, [{ module: 'web', id: ID1 }])
    assert.equal((await readIgnores(repo, root)).entries.length, 2)
  })
})

test('overlapping prefixes are stored as separate entries', async () => {
  await withRoot(async (root) => {
    await addIgnores(repo, [{ module: 'web', id: ID1 }], root, now)
    const result = await addIgnores(repo, [{ module: 'web', id: `${ID1}4ef` }], root, now)
    assert.equal(result.duplicates.length, 0)
    assert.equal((await readIgnores(repo, root)).entries.length, 2)
  })
})

const good = { module: 'web', id: ID1, addedAt: at.toISOString() }
const store = overrides => JSON.stringify({ version: 1, repo, entries: [good], ...overrides })
const unreadableStores = [
  ['invalid JSON', '{nope'],
  ['a JSON array', '[]'],
  ['a missing entries array', JSON.stringify({ version: 1, repo })],
  ['an entry missing module', store({ entries: [{ id: ID1, addedAt: good.addedAt }] })],
  ['an entry whose id is not a string', store({ entries: [{ ...good, id: 5 }] })],
  ['an entry whose id is not hex', store({ entries: [{ ...good, id: 'xyz' }] })],
  ['an unknown version', store({ version: 2 })],
  ['a different clone', store({ repo: resolve('/srv/other') })],
]

for (const [name, content] of unreadableStores) {
  test(`an unreadable store reads as zero entries: ${name}`, async () => {
    await withRoot(async (root) => {
      await mkdir(root, { recursive: true })
      await writeFile(storePath(repo, root), content)
      assert.deepEqual(await readIgnores(repo, root), { entries: [], unreadable: true })
    })
  })
}

test('a store path that cannot be read as a file reads as unreadable', async () => {
  await withRoot(async (root) => {
    await mkdir(storePath(repo, root), { recursive: true })
    assert.deepEqual(await readIgnores(repo, root), { entries: [], unreadable: true })
  })
})

test('writing over an unreadable store rebuilds it with only the new entries', async () => {
  await withRoot(async (root) => {
    await mkdir(root, { recursive: true })
    await writeFile(storePath(repo, root), '{nope')
    const result = await addIgnores(repo, [{ module: 'web', id: ID1 }], root, now)
    assert.equal(result.rebuilt, true)
    assert.deepEqual(await readIgnores(repo, root), { entries: [good], unreadable: false })
  })
})

test('isIgnored matches on equal module and an id prefix', () => {
  const full = 'a1b2c3d'.padEnd(64, '0')
  const entries = [{ module: 'web', id: ID1, addedAt: '' }]
  assert.equal(isIgnored(entries, 'web', `${ID1}${'0'.repeat(57)}`), true)
  assert.equal(isIgnored(entries, 'api', `${ID1}${'0'.repeat(57)}`), false)
  assert.equal(isIgnored(entries, 'web', 'a1b2c3e'.padEnd(64, '0')), false)
  const exact = [{ module: 'web', id: full, addedAt: '' }]
  assert.equal(isIgnored(exact, 'web', full), true)
  assert.equal(isIgnored(exact, 'web', `${ID1}${'1'.repeat(57)}`), false)
})
