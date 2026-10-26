import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile, access } from 'node:fs/promises'
import { resolveChoices } from '../src/resolver.js'
import { selectWithinRangeChoices } from '../src/coverage.js'
for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) test(`read-only splitting survives override cleanup: ${npmCli}`, async (t) => {
  const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
  const { shared } = await import('../../npm-dep-upgrade/test/e2e/fixtures/catalog.js')
  const f = await createProject(shared(true), { npmCli, installed: false }, t)
  const row = { package: 'e2e-target', version: '6.0.9', advisories: [{ range: '<6.0.10' }], requirements: [
    { declaredRequirement: '6.0.9', directDependents: [{ location: 'node_modules/e2e-parent-b', requestedName: 'e2e-target', type: 'dependencies', targetLocation: 'node_modules/e2e-target' }] },
    { declaredRequirement: '^6.0.8', directDependents: [{ location: 'node_modules/e2e-parent-a', requestedName: 'e2e-target', type: 'dependencies', targetLocation: 'node_modules/e2e-target' }] },
  ] }
  const choices = selectWithinRangeChoices(row, 'node_modules/e2e-target', ['6.0.12'])
  const before = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(`${f.root}/${name}`, 'utf8')))
  const result = await resolveChoices({ root: f.root }, { ...row, targetLocation: 'node_modules/e2e-target' }, choices, { env: f.env })
  assert.equal(result.coverage.resolution, 'partial')
  await assert.rejects(access(path.join(f.root, 'node_modules')), { code: 'ENOENT' })
  assert.equal(f.registry.calls.filter(c => c.phase !== 'seed' && c.path.startsWith('/tarballs/')).length, 0)
  assert.equal(result.choices.length, 1)
  assert.deepEqual(await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(`${f.root}/${name}`, 'utf8'))), before)
  assert.equal(result.coverage.remainingConsumers[0].location, 'node_modules/e2e-parent-b')
})

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) test(`partial scope ignores peer edges to its parent: ${npmCli}`, async (t) => {
  const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
  const { ago, leaf, parent, shared, target } = await import('../../npm-dep-upgrade/test/e2e/fixtures/catalog.js')
  const scenario = shared(true)
  const peerConsumer = 'e2e-peer-consumer'
  scenario.manifest.dependencies[peerConsumer] = '1.0.0'
  scenario.packages[peerConsumer] = {
    '1.0.0': { manifest: leaf(peerConsumer, '1.0.0', { peerDependencies: { [parent]: '*' } }), releasedAt: ago(20) },
  }
  const f = await createProject(scenario, { npmCli, installed: false }, t)
  const targetLocation = `node_modules/${target}`
  const row = { package: target, version: '6.0.9', advisories: [{ range: '<6.0.10' }], requirements: [
    { declaredRequirement: '^6.0.8', directDependents: [{ location: `node_modules/${parent}`, requestedName: target, type: 'dependencies', targetLocation }] },
    { declaredRequirement: '6.0.9', directDependents: [{ location: 'node_modules/e2e-parent-b', requestedName: target, type: 'dependencies', targetLocation }] },
  ] }
  const choices = selectWithinRangeChoices(row, targetLocation, ['6.0.12'])
  const result = await resolveChoices({ root: f.root }, { ...row, targetLocation }, choices, { env: f.env })
  const nodes = new Map(result.graph.nodes.map(node => [node.location, node]))
  const edgeVersion = (location) => {
    const edge = result.graph.edges.find(item => item.from === location && item.requestedName === target)
    return nodes.get(edge?.to)?.version
  }

  assert.equal(result.coverage.resolution, 'partial')
  assert.equal(edgeVersion(`node_modules/${parent}`), '6.0.12')
  assert.equal(edgeVersion('node_modules/e2e-parent-b'), '6.0.9')
})
