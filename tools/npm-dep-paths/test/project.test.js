import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProject } from '../src/project.js'

const tempRoot = process.env.NPM_DEP_PATHS_TEST_TMPDIR || tmpdir()

async function fixture(t, manifest = { name: 'app', version: '1.0.0', dependencies: { dep: '^2.0.0' } }, lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { dep: '^2.0.0' } },
    'node_modules/dep': { version: '2.1.0' },
  },
}) {
  const dir = await mkdtemp(join(tempRoot, 'npm-dep-paths-project-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock))
  return dir
}

test('loads ordinary v2 and v3 projects', async t => {
  for (const version of [2, 3]) {
    const dir = await fixture(t)
    const lock = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'package-lock.json'), 'utf8'))
    lock.lockfileVersion = version
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock))
    const project = await loadProject(dir)
    assert.equal(project.root, dir)
    assert.equal(project.manifest.name, 'app')
    assert.equal(project.lock.lockfileVersion, version)
  }
})

test('reports missing and malformed input files', async t => {
  const missing = await mkdtemp(join(tempRoot, 'npm-dep-paths-empty-'))
  t.after(() => rm(missing, { recursive: true, force: true }))
  await assert.rejects(loadProject(missing), /package\.json/)
  await writeFile(join(missing, 'package.json'), '{')
  await assert.rejects(loadProject(missing), /package\.json/)
  await writeFile(join(missing, 'package.json'), '{"name":"app","version":"1.0.0"}')
  await assert.rejects(loadProject(missing), /package-lock\.json/)
})

test('rejects unsupported lock and project structures', async t => {
  const dir = await fixture(t)
  const base = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'package-lock.json'), 'utf8'))
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ ...base, lockfileVersion: 1 }))
  await assert.rejects(loadProject(dir), /lockfileVersion/)
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(base))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', workspaces: ['packages/*'] }))
  await assert.rejects(loadProject(dir), /workspaces/)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: 'file:../dep' } }))
  await assert.rejects(loadProject(dir), /local dependency/)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  await writeFile(join(dir, 'npm-shrinkwrap.json'), '{}')
  await assert.rejects(loadProject(dir), /shrinkwrap/)
})

test('rejects incomplete root identity and stale root declarations', async t => {
  const dir = await fixture(t)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', dependencies: { dep: '^2.0.0' } }))
  await assert.rejects(loadProject(dir), /name/)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { dep: '^2.0.0' } }))
  await assert.rejects(loadProject(dir), /version/)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: '^3.0.0' } }))
  await assert.rejects(loadProject(dir), /stale|mismatch|dependencies/)
})

test('rejects linked and local lockfile entries', async t => {
  const dir = await fixture(t)
  const lock = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'package-lock.json'), 'utf8'))
  lock.packages['node_modules/dep'].link = true
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock))
  await assert.rejects(loadProject(dir), /link/)
  delete lock.packages['node_modules/dep'].link
  lock.packages['node_modules/dep'].resolved = 'file:../dep'
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock))
  await assert.rejects(loadProject(dir), /local/)
})
