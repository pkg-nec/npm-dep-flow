import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolveChoices } from '../src/resolver.js'
import { selectWithinRangeChoices } from '../src/coverage.js'
import { createProject } from '../../npm-dep-upgrade/test/e2e/helpers/project.js'
import { shared } from '../../npm-dep-upgrade/test/e2e/fixtures/catalog.js'
for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) test(`read-only splitting survives override cleanup: ${npmCli}`, async (t) => {
  const f = await createProject(shared(true), { npmCli, installed: false }, t)
  const row = { package: 'e2e-target', version: '6.0.9', advisories: [{ range: '<6.0.10' }], requirements: [
    { declaredRequirement: '6.0.9', directDependents: [{ location: 'node_modules/e2e-parent-b', requestedName: 'e2e-target', type: 'dependencies', targetLocation: 'node_modules/e2e-target' }] },
    { declaredRequirement: '^6.0.8', directDependents: [{ location: 'node_modules/e2e-parent-a', requestedName: 'e2e-target', type: 'dependencies', targetLocation: 'node_modules/e2e-target' }] },
  ] }
  const choices = selectWithinRangeChoices(row, 'node_modules/e2e-target', ['6.0.12'])
  const before = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(`${f.root}/${name}`, 'utf8')))
  const result = await resolveChoices({ root: f.root }, { ...row, targetLocation: 'node_modules/e2e-target' }, choices, { env: f.env })
  assert.equal(result.coverage.resolution, 'partial')
  assert.equal(result.choices.length, 1)
  assert.deepEqual(await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(`${f.root}/${name}`, 'utf8'))), before)
  assert.equal(result.coverage.remainingConsumers[0].location, 'node_modules/e2e-parent-b')
})
