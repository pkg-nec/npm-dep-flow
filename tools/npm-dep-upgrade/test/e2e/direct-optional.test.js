import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { direct } from './fixtures/catalog.js'
import { plan, runUpgrade, assertSuccess } from './helpers/runner.js'
for (const field of ['optionalDependencies']) for (const op of ['^', '~']) test(`D01 ${field} ${op}`, async (t) => {
  const f = await createProject(direct(field, op), {}, t), rows = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [rows[0].id, '--format', 'json']))
  const manifest = JSON.parse(await readFile(path.join(f.root, 'package.json')))
  assert.equal(manifest[field]['e2e-target'], op + '6.0.12')
  assert.equal(manifest.overrides, undefined)
})
