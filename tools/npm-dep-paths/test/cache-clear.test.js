import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearCache } from '../src/cache-clear.js'

const tempRoot = process.env.NPM_DEP_PATHS_TEST_TMPDIR || tmpdir()

async function scratch(t) {
  const dir = await mkdtemp(join(tempRoot, 'cache-clear-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('removes a populated cache directory', async (t) => {
  const cacheRoot = join(await scratch(t), 'cache')
  await mkdir(cacheRoot)
  await writeFile(join(cacheRoot, 'result-1.json'), '{}')
  await clearCache({ tool: 'fixture', cacheRoot })
  await assert.rejects(stat(cacheRoot), { code: 'ENOENT' })
})

test('succeeds when the cache directory is missing', async (t) => {
  await clearCache({ tool: 'fixture', cacheRoot: join(await scratch(t), 'missing') })
})

test('defaults to XDG_CACHE_HOME/<tool> and leaves other tools alone', async (t) => {
  const xdg = await scratch(t)
  await mkdir(join(xdg, 'fixture'))
  await mkdir(join(xdg, 'other'))
  await writeFile(join(xdg, 'fixture', 'x'), '1')
  await writeFile(join(xdg, 'other', 'x'), '1')
  const previous = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = xdg
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previous
  })
  await clearCache({ tool: 'fixture' })
  await assert.rejects(stat(join(xdg, 'fixture')), { code: 'ENOENT' })
  assert.ok((await stat(join(xdg, 'other', 'x'))).isFile())
})

test('propagates removal errors other than a missing path', async (t) => {
  const dir = await scratch(t)
  await writeFile(join(dir, 'file'), '1')
  await assert.rejects(clearCache({ tool: 'fixture', cacheRoot: join(dir, 'file', 'cache') }), { code: 'ENOTDIR' })
})
