import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.js'
import { execute, scratch } from './helpers/commands.js'

function capture() {
  let stdout = '', stderr = ''
  return { stdout: { write(s) {
    stdout += s
  } }, stderr: { write(s) {
    stderr += s
  } }, output: () => ({ stdout, stderr }) }
}
test('empty contexts need no dependency files and filtering never mutates inputs', async (t) => {
  const root = await scratch(t)
  const canonicalRoot = await realpath(root)
  const before = await readdir(root)
  const io = capture()
  const code = await main(['pkg', '--project', root, '--format', 'json', '--no-cache'], io, { fetchCatalog: async (cwd, name) => {
    assert.equal(cwd, canonicalRoot)
    assert.equal(name, 'pkg')
    return { schemaVersion: 2, package: name, fetchedAt: '2026-01-01T00:00:00.000Z', rows: [{ version: '1.0.0', releasedAt: null }, { version: '2.0.0-beta.1', releasedAt: null }] }
  } })
  assert.equal(code, 0, io.output().stderr)
  assert.deepEqual(JSON.parse(io.output().stdout).rows, [{ version: '1.0.0', releasedAt: null }])
  assert.deepEqual(await readdir(root), before)
})
test('invalid context or registry failure leaves stdout empty', async (t) => {
  const root = await scratch(t)
  await writeFile(join(root, 'file'), '')
  for (const directory of [join(root, 'missing'), join(root, 'file')]) {
    const io = capture()
    assert.equal(await main(['pkg', '--project', directory], io, { fetchCatalog: () => assert.fail('must not launch') }), 1)
    assert.equal(io.output().stdout, '')
    assert.match(io.output().stderr, /directory/i)
  }
  const io = capture()
  assert.equal(await main(['pkg', '--project', root, '--no-cache'], io, { fetchCatalog: async () => {
    throw new Error('npm view failed')
  } }), 1)
  assert.equal(io.output().stdout, '')
})
test('executable help and version work without npm or a package', async () => {
  const bin = fileURLToPath(new URL('../bin/npm-dep-versions.js', import.meta.url))
  const env = { ...process.env, PATH: '' }
  const help = await execute(process.execPath, [bin, '--help'], { env })
  assert.match(help.stdout, /--project/)
  assert.match(help.stdout, /--all/)
  assert.match((await execute(process.execPath, [bin, '--version'], { env })).stdout, /npm-dep-versions v.*\nLocation:/)
})

test('catalog is reused across filters and formats; bypass skips cache context and preserves entry', async (t) => {
  const root = await scratch(t)
  let fetches = 0, contexts = 0
  const deps = { cacheRoot: join(root, 'outside-cache'), readContext: async () => {
    contexts++
    return { npmVersion: '12', configHash: 'context' }
  }, fetchCatalog: async () => {
    fetches++
    return { schemaVersion: 2, package: 'pkg', fetchedAt: new Date().toISOString(), rows: [{ version: '1.0.0', releasedAt: null }, { version: '2.0.0-beta.1', releasedAt: null }] }
  } }
  for (const filters of [[], ['--all'], ['--major', '1'], ['--range', '>=1'], ['--format', 'json']]) assert.equal(await main(['pkg', '--project', root, ...filters], capture(), deps), 0)
  assert.equal(fetches, 1)
  assert.equal(contexts, 5)
  assert.equal(await main(['pkg', '--project', root, '--no-cache'], capture(), deps), 0)
  assert.equal(fetches, 2)
  assert.equal(contexts, 5)
})

const catalogFor = name => ({ schemaVersion: 2, package: name, fetchedAt: new Date().toISOString(), rows: [{ version: '1.0.0', releasedAt: null }] })

test('--clear-cache clears once, then fetches fresh data and rewrites the entry', async (t) => {
  const root = await scratch(t)
  const cacheRoot = join(await scratch(t), 'cache')
  const events = []
  const deps = {
    cacheRoot, readContext: async () => 'identity',
    clearCache: async (options) => {
      events.push(['clear', options.tool, options.cacheRoot])
      return (await import('../src/cache-clear.js')).clearCache(options)
    },
    fetchCatalog: async (cwd, name) => {
      events.push(['fetch'])
      return catalogFor(name)
    },
  }
  assert.equal(await main(['pkg', '--project', root, '--format', 'json'], capture(), deps), 0)
  const [entryName] = await readdir(cacheRoot)
  await writeFile(join(cacheRoot, entryName), 'poisoned')
  events.length = 0
  const io = capture()
  assert.equal(await main(['pkg', '--project', root, '--format', 'json', '--clear-cache'], io, deps), 0, io.output().stderr)
  assert.deepEqual(events, [['clear', 'npm-dep-versions', cacheRoot], ['fetch']])
  assert.notEqual(await readFile(join(cacheRoot, entryName), 'utf8'), 'poisoned')
})

test('--no-cache alone leaves a poisoned entry in place', async (t) => {
  const root = await scratch(t)
  const cacheRoot = join(await scratch(t), 'cache')
  await mkdir(cacheRoot)
  await writeFile(join(cacheRoot, 'catalog-x.json'), 'poisoned')
  assert.equal(await main(['pkg', '--project', root, '--no-cache'], capture(), { cacheRoot, fetchCatalog: async (cwd, name) => catalogFor(name) }), 0)
  assert.equal(await readFile(join(cacheRoot, 'catalog-x.json'), 'utf8'), 'poisoned')
})

test('--clear-cache with --no-cache clears and writes nothing; a missing directory is fine', async (t) => {
  const root = await scratch(t)
  const cacheRoot = join(await scratch(t), 'cache')
  await mkdir(cacheRoot)
  await writeFile(join(cacheRoot, 'catalog-x.json'), 'stale')
  const deps = { cacheRoot, fetchCatalog: async (cwd, name) => catalogFor(name) }
  assert.equal(await main(['pkg', '--project', root, '--clear-cache', '--no-cache'], capture(), deps), 0)
  await assert.rejects(stat(cacheRoot), { code: 'ENOENT' })
  assert.equal(await main(['pkg', '--project', root, '--clear-cache', '--no-cache'], capture(), deps), 0)
})

test('--clear-cache does not delete anything for --help or --version', async () => {
  const deps = { clearCache: () => assert.fail('must not clear') }
  const help = capture()
  assert.equal(await main(['--clear-cache', '--help'], help, deps), 0)
  assert.match(help.output().stdout, /^ {2}--clear-cache {2,}Delete this tool's cache; with no package, only clear$/m)
  assert.equal(await main(['--clear-cache', '--version'], capture(), deps), 0)
})

test('a cache that cannot be cleared exits 1 before any context or registry work', async (t) => {
  const root = await scratch(t)
  const io = capture()
  const deps = {
    clearCache: async () => {
      throw new Error('EACCES: cannot clear')
    },
    readContext: () => assert.fail('must not read context'),
    fetchCatalog: () => assert.fail('must not fetch'),
  }
  assert.equal(await main(['pkg', '--project', root, '--clear-cache'], io, deps), 1)
  assert.equal(io.output().stdout, '')
  assert.equal(io.output().stderr, 'npm-dep-versions: EACCES: cannot clear\n')
})

test('--clear-cache alone clears the cache and exits 0 without a package name', async (t) => {
  const cacheRoot = join(await scratch(t), 'cache')
  await mkdir(cacheRoot)
  await writeFile(join(cacheRoot, 'catalog-x.json'), 'stale')
  const io = capture()
  const deps = { cacheRoot, readContext: () => assert.fail('must not read context'), fetchCatalog: () => assert.fail('must not fetch') }
  assert.equal(await main(['--clear-cache'], io, deps), 0)
  assert.deepEqual(io.output(), { stdout: '', stderr: '' })
  await assert.rejects(stat(cacheRoot), { code: 'ENOENT' })
})

test('without --clear-cache a missing package name is still an error, and a bad one stays an error with it', async () => {
  const io = capture()
  assert.equal(await main([], io, {}), 1)
  assert.match(io.output().stderr, /valid package name is required/)
  assert.equal(await main(['a;echo', '--clear-cache'], capture(), { clearCache: () => assert.fail('must not clear') }), 1)
})
