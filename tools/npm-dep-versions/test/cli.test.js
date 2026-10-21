import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, realpath, writeFile } from 'node:fs/promises'
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
