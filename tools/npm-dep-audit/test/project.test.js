import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProject } from '../src/project.js'

async function project(manifest, lock) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-dep-audit-project-'))
  if (manifest !== null) await writeFile(join(dir, 'package.json'), manifest)
  if (lock !== null) await writeFile(join(dir, 'package-lock.json'), lock)
  return dir
}

for (const version of [2, 3]) {
  test(`loads lockfile version ${version} and exact input bytes`, async t => {
    const manifest = '{"name":"sample","version":"1.0.0"}\n'
    const lock = JSON.stringify({ lockfileVersion: version, packages: { '': { name: 'sample', version: '1.0.0' }, 'node_modules/a': { version: '1.0.0' } } }) + '\n'
    const dir = await project(manifest, lock)
    t.after(() => rm(dir, { recursive: true, force: true }))
    const result = await loadProject(dir)
    assert.equal(result.root, dir)
    assert.equal(result.manifestBytes.toString(), manifest)
    assert.equal(result.lockBytes.toString(), lock)
    assert.equal(result.lock.lockfileVersion, version)
  })
}

test('rejects missing manifest or lockfile', async t => {
  const dir = await project('{}', null)
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(loadProject(dir), /package-lock\.json/)
})

test('rejects unsupported lockfile and workspace', async t => {
  const dir = await project('{"workspaces":["packages/*"]}', '{"lockfileVersion":1,"packages":{}}')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(loadProject(dir), /lockfileVersion/)
  await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}')
  await assert.rejects(loadProject(dir), /workspaces/)
})

test('rejects local file dependencies and linked entries', async t => {
  const dir = await project('{"dependencies":{"local":"file:../local"}}', '{"lockfileVersion":3,"packages":{"":{}}}')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(loadProject(dir), /file:/)
  await writeFile(join(dir, 'package.json'), '{}')
  await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{},"node_modules/local":{"link":true,"resolved":"../local"}}}')
  await assert.rejects(loadProject(dir), /link/)
})

test('rejects shrinkwrap because npm would audit it instead of package-lock', async t => {
  const dir = await project('{}', '{"lockfileVersion":3,"packages":{"":{}}}')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"packages":{"":{}}}')
  await assert.rejects(loadProject(dir), /npm-shrinkwrap\.json/)
})
