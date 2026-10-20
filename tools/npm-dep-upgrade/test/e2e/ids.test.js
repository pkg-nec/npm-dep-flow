import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createProject } from './helpers/project.js'
import { direct, transitive, base, versions, leaf, ago, target } from './fixtures/catalog.js'
import { plan, runUpgrade, assertSuccess, assertUnchanged, assertResolved } from './helpers/runner.js'
const collisions = JSON.parse(await readFile(new URL('./fixtures/collisions.json', import.meta.url)))
const hash = (name, location) => createHash('sha256').update(`${name}__${location}`).digest('hex')
test('H01 full SHA256 IDs and Markdown abbreviations', async (t) => {
  const f = await createProject(transitive(), {}, t), rows = await plan(f), md = await plan(f, 'markdown')
  for (const r of rows) {
    assert.equal(r.id, hash(r.package, r.targetLocation))
    assert.match(md, new RegExp(r.id.slice(0, 7)))
  }
  const g = await createProject(transitive(), {}, t)
  assert.deepEqual((await plan(g)).map(r => r.id), rows.map(r => r.id))
})
for (const length of [7, 12, 64]) test(`H02 unique ${length}-character selector`, async (t) => {
  const f = await createProject(transitive(), {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id.slice(0, length), '--format', 'json', ...(length === 64 ? ['--package', row.package] : [])]))
})
test('H02 scoped exact-name automation selector', async (t) => {
  const f = await createProject(transitive('dependencies', '^', { parent: '@e2e/parent', target: '@e2e/target' }), {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--package', '@e2e/target', '--format', 'json']))
})
for (const byName of [true, false]) test(`H03 actual cross-package prefix collision ${byName ? 'name' : 'long ID'} disambiguation`, async (t) => {
  const pair = collisions.different
  assert.equal(pair[0].id.slice(0, 7), pair[1].id.slice(0, 7))
  for (const p of pair) assert.equal(hash(p.name, p.location), p.id)
  const s = base({ dependencies: Object.fromEntries(pair.map(p => [p.name, '^6.0.8'])) }, Object.fromEntries(pair.map(p => [p.name, versions(p.name)])), { targets: pair.map(p => p.name), advisories: pair.map((p, i) => ({ name: p.name, range: '<6.0.10', id: 10001 + i })) })
  const f = await createProject(s, {}, t), rows = await plan(f)
  assert.equal(rows.length, 2)
  await assertUnchanged(f, await runUpgrade(f, [pair[0].id.slice(0, 7)]), /ambiguous/i)
  await assertSuccess(f, await runUpgrade(f, [pair[0].id.slice(0, byName ? 7 : 64), ...(byName ? ['--package', pair[0].name] : []), '--format', 'json']))
  await assertResolved(f, '', pair[1].name, '6.0.9')
})
test('H04 actual same-package location collision requires longer ID', async (t) => {
  const pair = collisions.same
  for (const p of pair) assert.equal(hash(p.name, p.location), p.id)
  assert.equal(pair[0].id.slice(0, 7), pair[1].id.slice(0, 7))
  const s = direct()
  s.manifest.dependencies[target] = '^7.0.0'
  for (const p of pair) {
    s.manifest.dependencies[p.parent] = '1.0.0'
    s.packages[p.parent] = { '1.0.0': { manifest: leaf(p.parent, '1.0.0', { dependencies: { [target]: '^6.0.8' } }), releasedAt: ago(20) } }
  }
  const f = await createProject(s, {}, t), rows = await plan(f)
  assert.equal(rows.length, 2)
  await assertUnchanged(f, await runUpgrade(f, [pair[0].id.slice(0, 7), '--package', target]), /ambiguous/i)
  await assertSuccess(f, await runUpgrade(f, [pair[0].id, '--package', target, '--format', 'json']))
  await assertResolved(f, 'node_modules/' + pair[1].parent, target, '6.0.9')
})
