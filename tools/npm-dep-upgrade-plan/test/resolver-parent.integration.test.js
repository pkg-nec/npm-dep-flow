import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { resolveChoices } from '../src/resolver.js'

const day = 86400000
const ago = days => new Date(Date.now() - days * day).toISOString()
const leaf = (name, version, dependencies = {}) => ({ name, version, main: 'index.js', dependencies })
const entry = (name, version, dependencies, days, seed = true) => ({ manifest: leaf(name, version, dependencies), releasedAt: ago(days), seed })

// root -> b (pins a@1.2.3) and root -> c (^1.2.0): both share node_modules/a@1.2.3, and a@1.2.5 is safe.
function scenario(bVersions, extra = {}, rootDependencies = { b: '^1.0.0', c: '^1.0.0' }, cSpec = '^1.2.0') {
  return {
    manifest: { name: 'e2e-app', version: '1.0.0', private: true, dependencies: rootDependencies },
    targets: [], advisories: [],
    packages: {
      a: { '1.2.3': entry('a', '1.2.3', {}, 100), '1.2.5': entry('a', '1.2.5', {}, 50, false) },
      b: { '1.0.1': entry('b', '1.0.1', { a: '1.2.3' }, 90), ...bVersions },
      c: { '1.0.0': entry('c', '1.0.0', { a: cSpec }, 90) },
      ...extra,
    },
  }
}
const rowFor = (cSpec = '^1.2.0') => ({
  package: 'a', version: '1.2.3', advisories: [{ range: '<1.2.5' }], targetLocation: 'node_modules/a',
  requirements: [
    { declaredRequirement: '1.2.3', directDependents: [{ location: 'node_modules/b', requestedName: 'a', type: 'dependencies', targetLocation: 'node_modules/a' }] },
    { declaredRequirement: cSpec, directDependents: [{ location: 'node_modules/c', requestedName: 'a', type: 'dependencies', targetLocation: 'node_modules/a' }] },
  ],
})
const consumer = location => ({ location, requestedName: 'a', type: 'dependencies' })
const parentChoice = (name, version, current, location = `node_modules/${name}`, consumers = [consumer('node_modules/b')]) => ({
  strategy: 'upgrade-via-parent-dependency', targetPackage: name, targetLocation: location, currentVersion: current, targetVersion: version, affectedConsumers: consumers,
})
const files = async f => Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name), 'utf8')))
const versionAt = (graph, location) => graph.nodes.find(n => n.location === location)?.version

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) {
  const run = async (t, packages, choices, releaseTimes, cSpec = '^1.2.0') => {
    const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
    const f = await createProject(packages, { npmCli, installed: false }, t)
    const before = await files(f)
    const result = await resolveChoices({ root: f.root }, rowFor(cSpec), choices, { env: f.env, releaseTimes })
    assert.deepEqual(await files(f), before, 'the project files are never modified')
    return { f, result, before }
  }
  const b110 = entry('b', '1.1.0', { a: '1.2.5' }, 40, false)

  test(`parent that pins a safe version clears its branch and leaves a pinned shared consumer: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario({ '1.1.0': b110 }, {}, undefined, '1.2.3'), [parentChoice('b', '1.1.0', '1.0.1')], { 'b@1.1.0': b110.releasedAt }, '1.2.3')
    assert.equal(result.choices.length, 1)
    assert.equal(versionAt(result.graph, 'node_modules/b'), '1.1.0')
    assert.equal(versionAt(result.graph, 'node_modules/a'), '1.2.3')
    assert.equal(versionAt(result.graph, 'node_modules/b/node_modules/a'), '1.2.5')
    assert.equal(result.coverage.resolution, 'partial')
    assert.deepEqual(result.coverage.clearedConsumers, [consumer('node_modules/b')])
    assert.deepEqual(result.coverage.remainingConsumers, [consumer('node_modules/c')])
    const lock = JSON.parse(Buffer.from(result.snapshots[0].files['package-lock.json'], 'base64'))
    assert.equal(lock.packages['node_modules/b'].version, '1.1.0')
    assert.equal(JSON.parse(Buffer.from(result.snapshots[0].files['package.json'], 'base64')).overrides, undefined)
  })

  test(`npm may dedupe the shared installation upward so one parent upgrade clears every consumer: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario({ '1.1.0': b110 }), [parentChoice('b', '1.1.0', '1.0.1')], { 'b@1.1.0': b110.releasedAt })
    assert.equal(versionAt(result.graph, 'node_modules/a'), '1.2.5')
    assert.equal(result.coverage.resolution, 'complete')
    assert.deepEqual(result.coverage.remainingConsumers, [])
  })

  test(`the ancestor lands on exactly the tested release, not the newest in range: ${npmCli}`, async (t) => {
    const newest = entry('b', '1.2.0', { a: '^1.2.5' }, 10, false)
    const { result } = await run(t, scenario({ '1.1.0': b110, '1.2.0': newest }), [parentChoice('b', '1.1.0', '1.0.1')], { 'b@1.1.0': b110.releasedAt })
    assert.equal(versionAt(result.graph, 'node_modules/b'), '1.1.0')
  })

  test(`a candidate npm cannot produce is rejected instead of claimed: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario({ '1.1.0': b110 }), [parentChoice('b', '1.1.0', '1.0.1')], { 'b@1.1.0': ago(60) })
    assert.deepEqual(result.choices, [])
    assert.equal(result.coverage.resolution, 'none')
  })

  test(`a parent that drops the dependency clears its branch: ${npmCli}`, async (t) => {
    const removes = entry('b', '1.1.0', {}, 40, false)
    const { result } = await run(t, scenario({ '1.1.0': removes }), [parentChoice('b', '1.1.0', '1.0.1')], { 'b@1.1.0': removes.releasedAt })
    assert.equal(result.coverage.resolution, 'partial')
    assert.deepEqual(result.coverage.clearedConsumers, [consumer('node_modules/b')])
  })

  test(`a descendant that reintroduces the affected version is not claimed safe: ${npmCli}`, async (t) => {
    const reintroduces = entry('b', '1.1.0', { x: '^1.0.0' }, 40, false)
    const x = { '1.0.0': entry('x', '1.0.0', { a: '1.2.3' }, 60) }
    const { result } = await run(t, scenario({ '1.1.0': reintroduces }, { x }), [parentChoice('b', '1.1.0', '1.0.1')], { 'b@1.1.0': reintroduces.releasedAt })
    assert.equal(result.coverage.resolution, 'none')
  })

  test(`a grandparent upgrade can clear a branch through its resolved closure: ${npmCli}`, async (t) => {
    const g = { '1.0.0': entry('g', '1.0.0', { b: '1.0.1' }, 90), '1.1.0': entry('g', '1.1.0', { b: '^1.1.0' }, 30, false) }
    const packages = scenario({ '1.1.0': b110 }, { g }, { g: '^1.0.0', c: '^1.0.0' }, '1.2.3')
    const choice = parentChoice('g', '1.1.0', '1.0.0')
    const { result } = await run(t, packages, [choice], { 'g@1.1.0': g['1.1.0'].releasedAt }, '1.2.3')
    assert.equal(versionAt(result.graph, 'node_modules/g'), '1.1.0')
    assert.equal(versionAt(result.graph, 'node_modules/b'), '1.1.0')
    assert.deepEqual(result.coverage.clearedConsumers, [consumer('node_modules/b')])
    assert.equal(result.coverage.resolution, 'partial')
  })
}
