import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { direct, transitive, leaf, ago } from './fixtures/catalog.js'
import { plan, runUpgrade, assertUnchanged, assertSuccess } from './helpers/runner.js'
import { installCheckpoints, checked } from './helpers/commands.js'
for (const variant of ['tarball', 'integrity', 'peer']) test(`F02 G04 ${variant} install failure recovery`, async (t) => {
  const s = direct()
  if (variant === 'peer') {
    s.manifest.dependencies['e2e-peer'] = '1.0.0'
    s.packages['e2e-peer'] = { '1.0.0': { manifest: leaf('e2e-peer', '1.0.0'), releasedAt: ago(20) } }
    s.packages['e2e-target']['6.0.12'].manifest.peerDependencies = { 'e2e-peer': '2.0.0' }
  }
  const f = await createProject(s, {}, t), [row] = await plan(f)
  await writeFile(path.join(f.root, 'untracked.txt'), 'preserve')
  if (variant !== 'peer') s.request = ({ call }) => call.path === '/tarballs/e2e-target@6.0.12.tgz' ? (variant === 'tarball' ? { status: 404 } : { status: 200, raw: Buffer.from('corrupt-tarball') }) : null
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /install|integrity|peer|resolution/i)
  assert.equal(await readFile(path.join(f.root, 'untracked.txt'), 'utf8'), 'preserve')
})
for (const count of [1, 2]) test(`G04 initial or cleanup command failure phase ${count}`, async (t) => {
  const s = transitive(), f = await createProject(s, {}, t), [row] = await plan(f)
  s.checkpoint = info => info.count === count && info.stage === 'after' ? { exit: 42 } : {}
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /install.*(?:restored|not changed)/i)
})
test('O04 cleanup result unexpectedly reverts selected version', async (t) => {
  const s = transitive(), f = await createProject(s, {}, t), [row] = await plan(f)
  s.checkpoint = async ({ count, stage, cwd }) => {
    if (count === 1 && stage === 'after') {
      const file = path.join(cwd, 'package-lock.json'), lock = JSON.parse(await readFile(file))
      lock.packages['node_modules/e2e-target'].version = '6.0.9'
      await writeFile(file, JSON.stringify(lock, null, 2) + '\n')
    }
  }
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /verified dependency.*(?:restored|not changed)/i)
})
for (const trans of [false, true]) test(`F05 repeat resolved ${trans ? 'transitive' : 'direct'} ID creates no second commit`, async (t) => {
  const f = await createProject(trans ? transitive() : direct(), {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']))
  const head = await checked(f, 'git', ['rev-parse', 'HEAD']), before = await readFile(path.join(f.root, 'package-lock.json'))
  const r = await runUpgrade(f, [row.id])
  assert.equal(r.code, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /not found|no planner/i)
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), head)
  assert.deepEqual(await readFile(path.join(f.root, 'package-lock.json')), before)
})
test('G04 actual-project ci failure restores files and reports installed-tree uncertainty', async (t) => {
  const s = direct(), f = await createProject(s, {}, t), [row] = await plan(f)
  s.checkpoint = ({ count, stage }) => count === 2 && stage === 'after' ? { exit: 42 } : {}
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /restored.*node_modules may have changed/i)
})
