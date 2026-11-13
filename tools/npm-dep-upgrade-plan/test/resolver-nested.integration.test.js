import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChoices } from '../src/resolver.js'

const day = 86400000
const ago = days => new Date(Date.now() - days * day).toISOString()
const entry = (name, version, dependencies, days, seed = true) => ({ manifest: { name, version, main: 'index.js', dependencies }, releasedAt: ago(days), seed })

// root -> b -> a (vulnerable, pinned) -> j -> s@^2, while root -> d -> s@^1 hoists s@1.0.0, so j keeps its own s@2.
// b@1.1.0 brings a safe a, and s@2.0.1 is a newer release than the locked s@2.0.0 that is old enough to be used.
const scenario = () => ({
  manifest: { name: 'e2e-app', version: '1.0.0', private: true, dependencies: { b: '^1.0.0', d: '^1.0.0' } },
  targets: [], advisories: [],
  packages: {
    a: { '1.2.3': entry('a', '1.2.3', { j: '^1.0.0' }, 100), '1.2.5': entry('a', '1.2.5', { j: '^1.0.0' }, 50, false) },
    b: { '1.0.1': entry('b', '1.0.1', { a: '1.2.3' }, 90), '1.1.0': entry('b', '1.1.0', { a: '1.2.5' }, 40, false) },
    d: { '1.0.0': entry('d', '1.0.0', { s: '^1.0.0' }, 90) },
    j: { '1.0.0': entry('j', '1.0.0', { s: '^2.0.0' }, 90) },
    s: { '1.0.0': entry('s', '1.0.0', {}, 90), '2.0.0': entry('s', '2.0.0', {}, 90), '2.0.1': entry('s', '2.0.1', {}, 45, false) },
  },
})
const row = {
  package: 'a', version: '1.2.3', advisories: [{ range: '<1.2.5' }], targetLocation: 'node_modules/a',
  requirements: [{ declaredRequirement: '1.2.3', directDependents: [{ location: 'node_modules/b', requestedName: 'a', type: 'dependencies', targetLocation: 'node_modules/a' }] }],
}
const choice = {
  strategy: 'upgrade-via-parent-dependency', targetPackage: 'b', targetLocation: 'node_modules/b', currentVersion: '1.0.1', targetVersion: '1.1.0',
  affectedConsumers: [{ location: 'node_modules/b', requestedName: 'a', type: 'dependencies' }],
}
const versionAt = (graph, location) => graph.nodes.find(n => n.location === location)?.version

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) {
  test(`a nested installation a surviving dependent still needs is placed again when its release moves: ${npmCli}`, async (t) => {
    const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
    const f = await createProject(scenario(), { npmCli, installed: false }, t)
    const result = await resolveChoices({ root: f.root }, row, [choice], { env: f.env, releaseTimes: { 'b@1.1.0': ago(40) } })
    assert.equal(result.choices.length, 1, 'the upgrade is accepted')
    assert.equal(versionAt(result.graph, 'node_modules/s'), '1.0.0', 'the hoisted copy for the other dependent is untouched')
    assert.equal(versionAt(result.graph, 'node_modules/j/node_modules/s'), '2.0.1')
    assert.equal(result.coverage.resolution, 'complete')
  })
}
