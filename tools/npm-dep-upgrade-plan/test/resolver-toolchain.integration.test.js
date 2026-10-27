import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { resolveChoices } from '../src/resolver.js'
import { TOOLCHAIN_STRATEGY } from '../src/toolchain.js'

const day = 86400000
const ago = days => new Date(Date.now() - days * day).toISOString()
const leaf = (name, version, dependencies = {}) => ({ name, version, main: 'index.js', dependencies })
const entry = (name, version, dependencies, days, seed = true) => ({ manifest: leaf(name, version, dependencies), releasedAt: ago(days), seed })

// The root pins @angular/cli and @angular/build at 1.0.0; both pin kid@1.0.0 (depth 2), which is vulnerable.
// The 1.0.1 releases of both members depend on kid@1.0.1, and @angular/cli brings @angular-devkit/core along.
function scenario({ overrides, extra = {}, dependencies, build = {} } = {}) {
  const manifest = { name: 'e2e-app', version: '1.0.0', private: true, devDependencies: { '@angular/cli': '1.0.0', '@angular/build': '1.0.0' } }
  if (dependencies) manifest.dependencies = dependencies
  if (overrides) manifest.overrides = overrides
  return {
    manifest, targets: [], advisories: [],
    packages: {
      'kid': { '1.0.0': entry('kid', '1.0.0', {}, 100), '1.0.1': entry('kid', '1.0.1', {}, 40, false), '1.0.2': entry('kid', '1.0.2', {}, 30, false) },
      '@angular-devkit/core': { '1.0.0': entry('@angular-devkit/core', '1.0.0', {}, 100), '1.0.1': entry('@angular-devkit/core', '1.0.1', {}, 40, false) },
      '@angular/cli': {
        '1.0.0': entry('@angular/cli', '1.0.0', { 'kid': '1.0.0', '@angular-devkit/core': '1.0.0' }, 100),
        '1.0.1': entry('@angular/cli', '1.0.1', { 'kid': '1.0.1', '@angular-devkit/core': '1.0.1' }, 40, false),
      },
      '@angular/build': { '1.0.0': entry('@angular/build', '1.0.0', { kid: '1.0.0' }, 100), '1.0.1': entry('@angular/build', '1.0.1', { kid: '1.0.1', ...build }, 40, false) },
      ...extra,
    },
  }
}

const kidRow = {
  package: 'kid', version: '1.0.0', advisories: [{ range: '<1.0.1' }], targetLocation: 'node_modules/kid',
  requirements: [{ declaredRequirement: '1.0.0', directDependents: ['@angular/cli', '@angular/build'].map(name => ({ location: `node_modules/${name}`, requestedName: 'kid', type: 'dependencies', targetLocation: 'node_modules/kid' })) }],
}
const rootConsumer = { location: '', requestedName: '@angular/cli', type: 'devDependencies' }
const cliRow = {
  package: '@angular/cli', version: '1.0.0', advisories: [{ range: '<1.0.1' }], targetLocation: 'node_modules/@angular/cli',
  requirements: [{ declaredRequirement: '1.0.0', directDependents: [{ ...rootConsumer, targetLocation: 'node_modules/@angular/cli' }] }],
}
const consumer = location => ({ location, requestedName: 'kid', type: 'dependencies' })
const memberConsumers = [consumer('node_modules/@angular/build'), consumer('node_modules/@angular/cli')]
const toolchainChoice = (affectedConsumers = memberConsumers) => ({
  strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '1.0.0', targetVersion: '1.0.1', affectedConsumers,
})
const files = async f => Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name), 'utf8')))
const versionAt = (graph, location) => graph.nodes.find(n => n.location === location)?.version
const snapshotFile = (snapshot, name) => Buffer.from(snapshot.files[name], 'base64').toString()
const snapshotJson = (snapshot, name) => JSON.parse(snapshotFile(snapshot, name))

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) {
  const run = async (t, packages, row, choices, prepare) => {
    const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
    const f = await createProject(packages, { npmCli, installed: false }, t)
    await prepare?.(f)
    const before = await files(f)
    const result = await resolveChoices({ root: f.root }, row, choices, { env: f.env })
    assert.deepEqual(await files(f), before, 'the project files are never modified')
    return { f, result, before }
  }
  const assertBumped = (snapshot) => {
    const manifest = snapshotJson(snapshot, 'package.json'), lock = snapshotJson(snapshot, 'package-lock.json')
    assert.deepEqual(manifest.devDependencies, { '@angular/cli': '1.0.1', '@angular/build': '1.0.1' }, 'exact pins stay exact')
    assert.equal(lock.packages[''].devDependencies['@angular/cli'], '1.0.1')
    for (const name of ['@angular/cli', '@angular/build', '@angular-devkit/core']) assert.equal(lock.packages[`node_modules/${name}`].version, '1.0.1')
    return { manifest, lock }
  }

  test(`an exact-pinned toolchain bump clears the members' child and moves an existing override: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario({ overrides: { '@angular-devkit/core': '1.0.0' } }), kidRow, [toolchainChoice()])
    assert.equal(result.choices.length, 1)
    assert.equal(result.snapshots.length, 1)
    const { manifest } = assertBumped(result.snapshots[0])
    assert.deepEqual(manifest.overrides, { '@angular-devkit/core': '1.0.1' })
    assert.equal(snapshotFile(result.snapshots[0], 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'indentation and trailing newline are preserved')
    assert.equal(versionAt(result.graph, 'node_modules/kid'), '1.0.1')
    assert.equal(result.manifestChanged, true)
    assert.equal(result.coverage.resolution, 'complete')
    assert.deepEqual(result.coverage.clearedConsumers, memberConsumers)
    assert.deepEqual(result.coverage.remainingConsumers, [])
  })

  test(`a toolchain bump adds no override when the project has none: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario(), kidRow, [toolchainChoice()])
    const { manifest } = assertBumped(result.snapshots[0])
    assert.equal(manifest.overrides, undefined)
    assert.equal(result.coverage.resolution, 'complete')
  })

  test(`a toolchain bump preserves tab indentation, CRLF line endings and a missing trailing newline: ${npmCli}`, async (t) => {
    const write = text => async f => writeFile(path.join(f.root, 'package.json'), text)
    const packages = scenario({ overrides: { '@angular-devkit/core': '1.0.0' } })
    const { result } = await run(t, packages, kidRow, [toolchainChoice()], write(JSON.stringify(packages.manifest, null, '\t').replaceAll('\n', '\r\n')))
    const { manifest } = assertBumped(result.snapshots[0])
    assert.equal(snapshotFile(result.snapshots[0], 'package.json'), JSON.stringify(manifest, null, '\t').replaceAll('\n', '\r\n'))
    const crlf = await run(t, packages, kidRow, [toolchainChoice()], write(JSON.stringify(packages.manifest, null, 4).replaceAll('\n', '\r\n') + '\r\n'))
    assert.equal(snapshotFile(crlf.result.snapshots[0], 'package.json'), JSON.stringify(assertBumped(crlf.result.snapshots[0]).manifest, null, 4).replaceAll('\n', '\r\n') + '\r\n')
  })

  test(`a toolchain choice resolves first and a within-range choice for another consumer follows it: ${npmCli}`, async (t) => {
    const c = { '1.0.0': entry('c', '1.0.0', { kid: '1.0.0 || ^1.0.2' }, 90) }
    const row = { ...kidRow, requirements: [...kidRow.requirements, { declaredRequirement: '1.0.0 || ^1.0.2', directDependents: [{ ...consumer('node_modules/c'), targetLocation: 'node_modules/kid' }] }] }
    const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'kid', targetLocation: 'node_modules/kid', currentVersion: '1.0.0', targetVersion: '1.0.2', affectedConsumers: [consumer('node_modules/c')] }
    const choices = [toolchainChoice(), withinRange]
    const { result } = await run(t, scenario({ extra: { c }, dependencies: { c: '^1.0.0' } }), row, choices)
    assert.deepEqual(result.choices, choices, 'both choices are accepted')
    assert.deepEqual(result.snapshots.map(s => s.choiceIndex), [0, 1])
    const first = assertBumped(result.snapshots[0])
    assert.equal(first.lock.packages['node_modules/kid'].version, '1.0.0', 'the toolchain bump leaves the other consumer alone')
    assert.equal(first.lock.packages['node_modules/@angular/cli/node_modules/kid'].version, '1.0.1')
    assert.equal(first.lock.packages['node_modules/@angular/build/node_modules/kid'].version, '1.0.1')
    const second = assertBumped(result.snapshots[1])
    assert.equal(second.lock.packages['node_modules/kid'].version, '1.0.2')
    assert.equal(versionAt(result.graph, 'node_modules/kid'), '1.0.2')
    assert.equal(result.coverage.resolution, 'complete')
    assert.deepEqual(result.coverage.clearedConsumers, [...memberConsumers, consumer('node_modules/c')])
  })

  test(`a toolchain choice that is not first is refused: ${npmCli}`, async (t) => {
    const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'kid', targetLocation: 'node_modules/kid', currentVersion: '1.0.0', targetVersion: '1.0.1', affectedConsumers: memberConsumers }
    await assert.rejects(run(t, scenario(), kidRow, [withinRange, toolchainChoice()]), /Dependency resolver failed/)
  })

  test(`a vulnerable toolchain member clears its root declaration once it lands on a safe version: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario(), cliRow, [toolchainChoice([rootConsumer])])
    assert.equal(result.choices.length, 1)
    assertBumped(result.snapshots[0])
    assert.deepEqual(result.coverage.clearedConsumers, [rootConsumer])
    assert.deepEqual(result.coverage.remainingConsumers, [])
    assert.equal(result.coverage.resolution, 'complete')
  })

  test(`another copy of a vulnerable member reachable from the root is not counted against its declaration: ${npmCli}`, async (t) => {
    const extra = { 'x': { '1.0.0': entry('x', '1.0.0', { '@angular/cli': '0.9.0' }, 60, false) }, '@angular/cli': { '0.9.0': entry('@angular/cli', '0.9.0', {}, 200, false) } }
    const packages = scenario({ build: { x: '^1.0.0' } })
    Object.assign(packages.packages['@angular/cli'], extra['@angular/cli'])
    packages.packages.x = extra.x
    const { result } = await run(t, packages, cliRow, [toolchainChoice([rootConsumer])])
    assert.equal(versionAt(result.graph, 'node_modules/x/node_modules/@angular/cli'), '0.9.0')
    assert.deepEqual(result.coverage.clearedConsumers, [rootConsumer])
    assert.deepEqual(result.coverage.remainingConsumers, [])
    assert.equal(result.coverage.resolution, 'complete')
  })
}
