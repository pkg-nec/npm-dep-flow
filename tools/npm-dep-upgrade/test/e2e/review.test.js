import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createProject } from './helpers/project.js'
import { direct, leaf, ago } from './fixtures/catalog.js'
import { plan, runUpgrade, assertSuccess, assertUnchanged } from './helpers/runner.js'
import { installCheckpoints, checked } from './helpers/commands.js'
test('review concurrent lock metadata is preserved and never committed', async (t) => {
  const s = direct(), f = await createProject(s, {}, t), [row] = await plan(f)
  s.checkpoint = async ({ stage, count }) => {
    if (stage === 'after' && count === 2) {
      const file = path.join(f.root, 'package-lock.json'), lock = JSON.parse(await readFile(file))
      lock.userNote = 'concurrent user edit'
      await writeFile(file, JSON.stringify(lock, null, 2) + '\n')
    }
  }
  await installCheckpoints(f)
  const r = await runUpgrade(f, [row.id])
  assert.equal(r.code, 1, r.stdout)
  assert.equal(r.stdout, '')
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), f.initialHead)
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'package-lock.json'))).userNote, 'concurrent user edit')
  assert.deepEqual(await readFile(path.join(f.root, 'package.json')), f.initialFiles['package.json'])
})
for (const variant of ['unrelated resolver change', 'v2 legacy']) test(`review rejected ${variant} restores original dependency bytes`, async (t) => {
  const s = direct()
  s.manifest.dependencies['e2e-other'] = '^1.0.0'
  s.packages['e2e-other'] = { '1.0.0': { manifest: leaf('e2e-other', '1.0.0'), releasedAt: ago(20) }, '1.0.1': { manifest: leaf('e2e-other', '1.0.1'), releasedAt: ago(20), seed: false } }
  const f = await createProject(s, { lockfileVersion: variant === 'v2 legacy' ? 2 : 3 }, t), [row] = await plan(f)
  s.checkpoint = async ({ count, stage, cwd }) => {
    if (count !== 2 || stage !== 'after') return
    const file = path.join(cwd || f.root, 'package-lock.json'), lock = JSON.parse(await readFile(file))
    if (variant === 'v2 legacy')lock.dependencies['e2e-target'].version = '6.0.9'; else
      lock.packages['node_modules/e2e-other'].version = '1.0.1'
    await writeFile(file, JSON.stringify(lock, null, 2) + '\n')
  }
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /unrelated|legacy|inconsistent/i)
})
test('review stable build-metadata safe release installs exact identity', async (t) => {
  const s = direct()
  for (const v of ['6.0.10', '6.0.12']) delete s.packages['e2e-target'][v]
  s.packages['e2e-target']['6.0.12+build.1'] = { manifest: leaf('e2e-target', '6.0.12+build.1'), releasedAt: ago(20) }
  const f = await createProject(s, {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']), '6.0.12+build.1', { reproduce: true })
})
test('review private install cannot publish unrelated manifest edits', async (t) => {
  const s = direct(), f = await createProject(s, {}, t), [row] = await plan(f)
  s.checkpoint = async ({ count, stage, cwd }) => {
    if (count !== 2 || stage !== 'after') return
    const manifestFile = path.join(cwd, 'package.json'), lockFile = path.join(cwd, 'package-lock.json')
    const manifest = JSON.parse(await readFile(manifestFile)), lock = JSON.parse(await readFile(lockFile))
    manifest.description = 'unexpected resolver edit'
    lock.packages[''].description = manifest.description
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(lockFile, JSON.stringify(lock, null, 2) + '\n')
  }
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /manifest|package.json|mutation/i)
})
