import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { direct, ago } from './fixtures/catalog.js'
import { plan, runUpgrade, assertSuccess } from './helpers/runner.js'
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const op of ['^', '~']) test(`D01 ${field} ${op}`, async (t) => {
  const f = await createProject(direct(field, op), {}, t), rows = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [rows[0].id, '--format', 'json']))
  const manifest = JSON.parse(await readFile(path.join(f.root, 'package.json')))
  assert.equal(manifest[field]['e2e-target'], op + '6.0.12')
  assert.equal(manifest.overrides, undefined)
})
for (const op of ['^', '~']) test(`D02 ${op} upper bounds`, async (t) => {
  const s = direct('dependencies', op)
  s.packages['e2e-target']['6.1.0'].releasedAt = ago(20)
  const f = await createProject(s, {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']), op === '^' ? '6.1.0' : '6.0.12')
})
test('D04 compatible duplicate declarations retain both operators', async (t) => {
  const s = direct('devDependencies', '~')
  s.manifest.peerDependencies = { 'e2e-target': '^6.0.8' }
  const f = await createProject(s, {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']))
  const m = JSON.parse(await readFile(path.join(f.root, 'package.json')))
  assert.equal(m.devDependencies['e2e-target'], '~6.0.12')
  assert.equal(m.peerDependencies['e2e-target'], '^6.0.12')
})
