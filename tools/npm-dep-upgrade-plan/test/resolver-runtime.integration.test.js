import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { resolveChoices, runWorker } from '../src/resolver.js'
import { lineOfStrategy } from '../src/angular-lines.js'

const day = 86400000
const ago = days => new Date(Date.now() - days * day).toISOString()
const entry = (manifest, days, seed = true) => ({ manifest: { main: 'index.js', dependencies: {}, ...manifest }, releasedAt: ago(days), seed })
const toolchain = lineOfStrategy('upgrade-angular-toolchain')
const runtime = lineOfStrategy('upgrade-angular-runtime')
const RUNTIME = runtime.members
const TOOLCHAIN = toolchain.members
const PBD = '@angular/platform-browser-dynamic'

// The root pins the seven runtime members at 2.0.0 (@angular/compiler-cli in devDependencies) and the toolchain at
// 1.0.0, as Angular projects do. The peers follow the real packages: runtime members peer on exact versions of each
// other, and @angular/build peers on `^2.0.0` ranges of the runtime (@angular/core and @angular/platform-browser
// optional). @angular/core and both toolchain members pin the vulnerable kid@1.0.0; their next releases pin kid@1.0.1.
const PEERS = {
  '@angular/common': ['@angular/core'], '@angular/compiler': [], '@angular/compiler-cli': ['@angular/compiler'], '@angular/core': ['@angular/compiler'],
  '@angular/forms': ['@angular/core', '@angular/common', '@angular/platform-browser'], '@angular/platform-browser': ['@angular/core', '@angular/common'],
  '@angular/router': ['@angular/core', '@angular/common', '@angular/platform-browser'],
}
const BUILD_PEERS = { peerDependencies: Object.fromEntries(['@angular/core', '@angular/compiler', '@angular/compiler-cli', '@angular/platform-browser'].map(name => [name, '^2.0.0'])), peerDependenciesMeta: { '@angular/core': { optional: true }, '@angular/platform-browser': { optional: true } } }

function scenario({ overrides, pbd = false, extra = {}, dependencies = {}, devDependencies = {}, core = {} } = {}) {
  const manifest = {
    name: 'e2e-app', version: '1.0.0', private: true,
    dependencies: { ...Object.fromEntries(RUNTIME.filter(name => name !== '@angular/compiler-cli').map(name => [name, '2.0.0'])), ...dependencies },
    devDependencies: { '@angular/compiler-cli': '2.0.0', '@angular/cli': '1.0.0', '@angular/build': '1.0.0', ...devDependencies },
  }
  if (overrides) manifest.overrides = overrides
  const kidOf = version => (version.endsWith('.0') ? '1.0.0' : '1.0.1')
  const member = (name, version) => {
    const peerDependencies = Object.fromEntries(PEERS[name].map(peer => [peer, version]))
    const deps = name === '@angular/core' ? { kid: kidOf(version), ...(version === '2.0.1' ? core : {}) } : {}
    if (pbd && name === '@angular/platform-browser') deps[PBD] = '^2.0.0'
    return { name, version, dependencies: deps, peerDependencies, ...(name === '@angular/core' ? { peerDependenciesMeta: { '@angular/compiler': { optional: true } } } : {}) }
  }
  const tool = (name, version) => ({ name, version, dependencies: { kid: kidOf(version) }, ...(name === '@angular/build' ? BUILD_PEERS : {}) })
  return {
    manifest, targets: [], advisories: [],
    packages: {
      kid: { '1.0.0': entry({ name: 'kid', version: '1.0.0' }, 100), '1.0.1': entry({ name: 'kid', version: '1.0.1' }, 50, false), '1.0.2': entry({ name: 'kid', version: '1.0.2' }, 45, false) },
      [PBD]: { '2.0.0': entry({ name: PBD, version: '2.0.0' }, 100), '2.0.1': entry({ name: PBD, version: '2.0.1' }, 40, false) },
      ...Object.fromEntries(RUNTIME.map(name => [name, { '2.0.0': entry(member(name, '2.0.0'), 100), '2.0.1': entry(member(name, '2.0.1'), 40, false) }])),
      ...Object.fromEntries(TOOLCHAIN.map(name => [name, { '1.0.0': entry(tool(name, '1.0.0'), 100), '1.0.1': entry(tool(name, '1.0.1'), 40, false) }])),
      ...extra,
    },
  }
}

const consumer = location => ({ location, requestedName: 'kid', type: 'dependencies' })
const dependentOf = location => ({ ...consumer(location), targetLocation: 'node_modules/kid' })
const CORE = 'node_modules/@angular/core', CLI = 'node_modules/@angular/cli', BUILD = 'node_modules/@angular/build'
const kidRow = {
  package: 'kid', version: '1.0.0', advisories: [{ range: '<1.0.1' }], targetLocation: 'node_modules/kid',
  requirements: [{ declaredRequirement: '1.0.0', directDependents: [CORE, CLI, BUILD].map(dependentOf) }],
}
const runtimeChoice = (affectedConsumers = [consumer(CORE)]) => ({ strategy: runtime.strategy, targetPackage: '@angular/core', targetLocation: CORE, currentVersion: '2.0.0', targetVersion: '2.0.1', affectedConsumers })
const toolchainChoice = () => ({ strategy: toolchain.strategy, targetPackage: '@angular/cli', targetLocation: CLI, currentVersion: '1.0.0', targetVersion: '1.0.1', affectedConsumers: [consumer(BUILD), consumer(CLI)] })
const files = async f => Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name), 'utf8')))
const versionAt = (graph, location) => graph.nodes.find(n => n.location === location)?.version
const snapshotJson = (snapshot, name) => JSON.parse(Buffer.from(snapshot.files[name], 'base64').toString())
const versionsOf = (lock, names) => Object.fromEntries(names.map(name => [name, lock.packages[`node_modules/${name}`]?.version]))
const sorted = consumers => consumers.map(c => JSON.stringify(c)).sort()
const assertConsumers = (actual, expected) => assert.deepEqual(sorted(actual), sorted(expected))
const all = (names, version) => Object.fromEntries(names.map(name => [name, version]))

// Runs the worker in strict mode so a rejected choice surfaces its reason instead of being skipped.
const strictly = capture => async ([worker, request], options) => {
  await writeFile(request, JSON.stringify({ ...JSON.parse(await readFile(request, 'utf8')), strict: true }))
  const script = `import { readFile } from 'node:fs/promises'
import { resolveRequest } from ${JSON.stringify(pathToFileURL(worker).href)}
try { await resolveRequest(JSON.parse(await readFile(process.argv[1], 'utf8'))) }
catch (error) { process.stderr.write(error.message); process.exitCode = 1 }`
  const response = await runWorker(['--input-type=module', '-e', script, request], options)
  capture.stderr = response.stderr
  return response
}

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) {
  const run = async (t, packages, row, choices, options = {}) => {
    const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
    const f = await createProject(packages, { npmCli, installed: false }, t)
    const before = await files(f)
    const result = await resolveChoices({ root: f.root }, row, choices, { env: f.env, ...options })
    assert.deepEqual(await files(f), before, 'the project files are never modified')
    return { f, result }
  }
  const assertRuntimeBumped = (snapshot, toolchainVersion = '1.0.0') => {
    const manifest = snapshotJson(snapshot, 'package.json'), lock = snapshotJson(snapshot, 'package-lock.json')
    assert.deepEqual(manifest.dependencies, all(RUNTIME.filter(name => name !== '@angular/compiler-cli'), '2.0.1'), 'every runtime member moves in dependencies')
    assert.deepEqual(manifest.devDependencies, { '@angular/compiler-cli': '2.0.1', '@angular/cli': toolchainVersion, '@angular/build': toolchainVersion }, 'compiler-cli moves in devDependencies')
    assert.deepEqual(versionsOf(lock, RUNTIME), all(RUNTIME, '2.0.1'))
    assert.deepEqual(versionsOf(lock, TOOLCHAIN), all(TOOLCHAIN, toolchainVersion), 'the toolchain does not move with the runtime')
    return { manifest, lock }
  }

  test(`a runtime bump rewrites the members in their own fields and leaves the toolchain alone: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario(), kidRow, [runtimeChoice()])
    assert.equal(result.choices.length, 1)
    const { manifest } = assertRuntimeBumped(result.snapshots[0])
    assert.equal(manifest.overrides, undefined, 'no override is added')
    assert.equal(versionAt(result.graph, `${CORE}/node_modules/kid`) ?? versionAt(result.graph, 'node_modules/kid'), '1.0.1')
    assertConsumers(result.coverage.clearedConsumers, [consumer(CORE)])
    assertConsumers(result.coverage.remainingConsumers, [consumer(CLI), consumer(BUILD)])
    assert.equal(result.coverage.resolution, 'partial')
  })

  test(`a toolchain bump whose peers the runtime satisfies leaves the runtime alone: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario(), kidRow, [toolchainChoice()])
    assert.equal(result.choices.length, 1)
    const lock = snapshotJson(result.snapshots[0], 'package-lock.json')
    assert.deepEqual(versionsOf(lock, TOOLCHAIN), all(TOOLCHAIN, '1.0.1'))
    assert.deepEqual(versionsOf(lock, RUNTIME), all(RUNTIME, '2.0.0'), 'the runtime does not move with the toolchain')
    assertConsumers(result.coverage.clearedConsumers, [consumer(CLI), consumer(BUILD)])
  })

  for (const [name, overrides, expected, pbd] of [
    ['a string override', { [PBD]: '2.0.0' }, { [PBD]: '2.0.1' }, true],
    ['an object-form override', { [PBD]: { '.': '2.0.0' } }, { [PBD]: { '.': '2.0.1' } }, true],
    ['a stale override with no lockfile entry and no dependent', { [PBD]: '2.0.0' }, { [PBD]: '2.0.1' }, false],
  ]) {
    test(`a runtime bump updates ${name} of ${PBD}: ${npmCli}`, async (t) => {
      const { f, result } = await run(t, scenario({ overrides, pbd }), kidRow, [runtimeChoice()])
      const original = JSON.parse((await files(f))[1])
      assert.equal(original.packages[`node_modules/${PBD}`]?.version, pbd ? '2.0.0' : undefined)
      assert.equal(result.choices.length, 1)
      const { manifest, lock } = assertRuntimeBumped(result.snapshots[0])
      assert.deepEqual(manifest.overrides, expected)
      assert.equal(lock.packages[`node_modules/${PBD}`]?.version, pbd ? '2.0.1' : undefined, 'a stale override installs nothing')
    })
  }

  test(`with an installed ${PBD} and no override, the runtime bump adds none and leaves it alone: ${npmCli}`, async (t) => {
    const { result } = await run(t, scenario({ pbd: true }), kidRow, [runtimeChoice()])
    const { manifest, lock } = assertRuntimeBumped(result.snapshots[0])
    assert.equal(manifest.overrides, undefined)
    assert.equal(lock.packages[`node_modules/${PBD}`].version, '2.0.0')
  })

  test(`a runtime choice resolves second after a toolchain choice: ${npmCli}`, async (t) => {
    const choices = [toolchainChoice(), runtimeChoice()]
    const { result } = await run(t, scenario(), kidRow, choices)
    assert.deepEqual(result.choices, choices, 'both choices are accepted')
    assert.deepEqual(result.snapshots.map(s => s.choiceIndex), [0, 1])
    const first = snapshotJson(result.snapshots[0], 'package-lock.json')
    assert.deepEqual(versionsOf(first, TOOLCHAIN), all(TOOLCHAIN, '1.0.1'))
    assert.deepEqual(versionsOf(first, RUNTIME), all(RUNTIME, '2.0.0'))
    assertRuntimeBumped(result.snapshots[1], '1.0.1')
    assert.equal(result.coverage.resolution, 'complete')
    assertConsumers(result.coverage.clearedConsumers, [consumer(CORE), consumer(CLI), consumer(BUILD)])
  })

  test(`a runtime choice that is not after the toolchain choice is refused: ${npmCli}`, async (t) => {
    await assert.rejects(run(t, scenario(), kidRow, [runtimeChoice(), toolchainChoice()]), /Dependency resolver failed/)
  })

  test(`a runtime choice resolves first and a within-range choice for another consumer follows it: ${npmCli}`, async (t) => {
    const c = { '1.0.0': entry({ name: 'c', version: '1.0.0', dependencies: { kid: '1.0.0 || ^1.0.2' } }, 90) }
    const row = { ...kidRow, requirements: [{ declaredRequirement: '1.0.0', directDependents: [dependentOf(CORE)] }, { declaredRequirement: '1.0.0 || ^1.0.2', directDependents: [dependentOf('node_modules/c')] }] }
    const packages = scenario({ extra: { c }, dependencies: { c: '^1.0.0' } })
    packages.manifest.devDependencies = { '@angular/compiler-cli': '2.0.0' }
    const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'kid', targetLocation: 'node_modules/kid', currentVersion: '1.0.0', targetVersion: '1.0.2', affectedConsumers: [consumer('node_modules/c')] }
    const choices = [runtimeChoice(), withinRange]
    const { result } = await run(t, packages, row, choices)
    assert.deepEqual(result.choices, choices, 'both choices are accepted')
    assert.deepEqual(result.snapshots.map(s => s.choiceIndex), [0, 1])
    const first = snapshotJson(result.snapshots[0], 'package-lock.json')
    assert.equal(first.packages['node_modules/kid'].version, '1.0.0', 'the runtime bump leaves the other consumer alone')
    assert.equal(first.packages[`${CORE}/node_modules/kid`].version, '1.0.1')
    const second = snapshotJson(result.snapshots[1], 'package-lock.json')
    assert.equal(second.packages['node_modules/kid'].version, '1.0.2')
    assert.deepEqual(versionsOf(second, RUNTIME), all(RUNTIME, '2.0.1'))
    assert.equal(result.coverage.resolution, 'complete')
    assertConsumers(result.coverage.clearedConsumers, [consumer(CORE), consumer('node_modules/c')])
  })

  // @angular/core@2.0.1 needs a newer @angular/build than the root's lock holds, and the root's `^1.0.0` lets npm
  // replace it: a runtime-only choice may not move a toolchain member, even inside the runtime closure.
  test(`a runtime-only choice that makes npm move a toolchain member is rejected: ${npmCli}`, async (t) => {
    const packages = scenario({ devDependencies: { '@angular/build': '^1.0.0' }, core: { '@angular/build': '^1.0.1' } })
    const { result } = await run(t, packages, kidRow, [runtimeChoice()])
    assert.deepEqual(result.choices, [])
    assert.deepEqual(result.snapshots, [])
    assert.equal(result.manifestChanged, false)
    assert.equal(result.coverage.resolution, 'none')
    const capture = {}
    await assert.rejects(run(t, packages, kidRow, [runtimeChoice()], { run: strictly(capture) }), /Dependency resolver failed/)
    assert.equal(capture.stderr, 'Unrelated installation changed')
    const both = await run(t, packages, kidRow, [toolchainChoice(), runtimeChoice()])
    assert.equal(both.result.choices.length, 2, 'with the toolchain bumped first the same runtime bump is accepted')
  })
}
