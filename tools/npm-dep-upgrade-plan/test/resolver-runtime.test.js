import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { assertLineOrder, computeCoverage, lineManifest, memberEdges, verifyResolution } from '../src/resolver-worker.js'
import { ANGULAR_LINES, lineOfStrategy } from '../src/angular-lines.js'

const toolchain = lineOfStrategy('upgrade-angular-toolchain')
const runtime = lineOfStrategy('upgrade-angular-runtime')
const RUNTIME = ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router']
const TOOLCHAIN = ['@angular/cli', '@angular/build']

const node = (location, name, version) => ({ location, name, version })
const edge = (from, to, requestedName, rawSpec, extra = {}) => ({ from, to, requestedName, type: 'dependencies', rawSpec, effectiveSpec: rawSpec, valid: true, ...extra })
const rootEdge = (name, version) => edge('', `node_modules/${name}`, name, version, { type: ['@angular/compiler-cli', ...TOOLCHAIN].includes(name) ? 'devDependencies' : 'dependencies' })
const consumerOf = (location, requestedName = 'kid') => ({ location, requestedName, type: 'dependencies' })
const kid = { package: 'kid', version: '1.0.0', targetLocation: 'node_modules/kid', advisories: [{ range: '<1.0.1' }] }
const runtimeChoice = (extra = {}) => ({
  strategy: runtime.strategy, targetPackage: '@angular/core', targetLocation: 'node_modules/@angular/core', currentVersion: '2.0.0', targetVersion: '2.0.1',
  affectedConsumers: [consumerOf('node_modules/@angular/core')], ...extra,
})
const toolchainChoice = (extra = {}) => ({
  strategy: toolchain.strategy, targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '1.0.0', targetVersion: '1.0.1',
  affectedConsumers: [consumerOf('node_modules/@angular/build')], ...extra,
})
const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'kid', targetLocation: 'node_modules/kid', currentVersion: '1.0.0', targetVersion: '1.0.2', affectedConsumers: [consumerOf('node_modules/c')] }

// The root declares the seven runtime members at `rt` and the two toolchain members at `tc`. @angular/core and
// @angular/build depend on kid; @angular/build has peers on @angular/core and @angular/compiler-cli; root -> c.
const treeAt = ({ rt = '2.0.0', tc = '1.0.0', moved = {}, kidVersion = '1.0.0', extraNodes = [], extraEdges = [], dropEdges = () => false } = {}) => {
  const version = name => moved[name] ?? (RUNTIME.includes(name) ? rt : tc)
  return {
    nodes: [node('', 'app', '1.0.0'), ...[...RUNTIME, ...TOOLCHAIN].map(name => node(`node_modules/${name}`, name, version(name))), node('node_modules/kid', 'kid', kidVersion), node('node_modules/c', 'c', '1.0.0'), ...extraNodes],
    edges: [
      ...[...RUNTIME, ...TOOLCHAIN].map(name => rootEdge(name, version(name))), edge('', 'node_modules/c', 'c', '^1.0.0'),
      edge('node_modules/@angular/core', 'node_modules/kid', 'kid', kidVersion), edge('node_modules/@angular/build', 'node_modules/kid', 'kid', kidVersion),
      edge('node_modules/@angular/build', 'node_modules/@angular/core', '@angular/core', '^2.0.0', { type: 'peerDependencies' }),
      edge('node_modules/@angular/build', 'node_modules/@angular/compiler-cli', '@angular/compiler-cli', '^2.0.0', { type: 'peerDependencies' }),
      ...extraEdges,
    ].filter(e => !dropEdges(e)),
  }
}
const before = treeAt()

test('the runtime member edges are the seven root declarations, in their own fields', () => {
  assert.deepEqual(memberEdges(before, runtime).map(e => [e.requestedName, e.type]), RUNTIME.map(name => [name, name === '@angular/compiler-cli' ? 'devDependencies' : 'dependencies']))
})

test('a runtime bump that moves every runtime member and nothing outside their closures is accepted', () => {
  const after = treeAt({ rt: '2.0.1', kidVersion: '1.0.1' })
  verifyResolution(before, after, kid, [runtimeChoice()], semver)
  assert.deepEqual(computeCoverage(before, after, kid, semver).clearedConsumers, [consumerOf('node_modules/@angular/core'), consumerOf('node_modules/@angular/build')])
})

test('a runtime member that lands elsewhere or moved since planning is rejected', () => {
  assert.throws(() => verifyResolution(before, treeAt({ rt: '2.0.1', moved: { '@angular/forms': '2.0.2' } }), kid, [runtimeChoice()], semver), /^Error: Runtime member did not resolve to the tested version$/)
  assert.throws(() => verifyResolution(before, treeAt({ rt: '2.0.1' }), kid, [runtimeChoice({ currentVersion: '1.9.0' })], semver), /^Error: Runtime installation changed since planning$/)
})

test('a runtime bump may not move @angular/cli or @angular/build, even though @angular/build peers on the runtime', () => {
  for (const name of TOOLCHAIN) {
    assert.throws(() => verifyResolution(before, treeAt({ rt: '2.0.1', moved: { [name]: '1.0.1' } }), kid, [runtimeChoice()], semver), /^Error: Unrelated installation changed$/, name)
  }
})

test('a toolchain bump may not move a runtime package, even one its peers name', () => {
  for (const name of ['@angular/core', '@angular/compiler-cli', '@angular/router']) {
    assert.throws(() => verifyResolution(before, treeAt({ tc: '1.0.1', moved: { [name]: '2.0.1' } }), kid, [toolchainChoice()], semver), /^Error: Unrelated installation changed$/, name)
  }
  verifyResolution(before, treeAt({ tc: '1.0.1', kidVersion: '1.0.1' }), kid, [toolchainChoice()], semver)
})

test('a toolchain bump and then a runtime bump are both verified against the original graph', () => {
  const both = treeAt({ rt: '2.0.1', tc: '1.0.1', kidVersion: '1.0.1' })
  verifyResolution(before, treeAt({ tc: '1.0.1', kidVersion: '1.0.1' }), kid, [toolchainChoice()], semver)
  verifyResolution(before, both, kid, [toolchainChoice(), runtimeChoice()], semver)
  assert.throws(() => verifyResolution(before, both, kid, [runtimeChoice()], semver), /^Error: Unrelated installation changed$/, 'without the toolchain choice the moved toolchain is unrelated')
  assert.equal(computeCoverage(before, both, kid, semver).resolution, 'complete')
})

test('a runtime choice may be combined with a within-range choice for another consumer', () => {
  const link = [edge('node_modules/c', 'node_modules/kid', 'kid', '1.0.0 || ^1.0.2')]
  const start = treeAt({ extraEdges: link })
  const nested = 'node_modules/@angular/core/node_modules/kid'
  const finish = treeAt({
    rt: '2.0.1', kidVersion: '1.0.2', extraNodes: [node(nested, 'kid', '1.0.1')],
    extraEdges: [...link, edge('node_modules/@angular/core', nested, 'kid', '1.0.1')],
    dropEdges: e => e.from === 'node_modules/@angular/core' && e.to === 'node_modules/kid',
  })
  const choices = [runtimeChoice(), { ...withinRange, affectedConsumers: [consumerOf('node_modules/c'), consumerOf('node_modules/@angular/build')] }]
  const pinnedBuild = { ...finish, edges: finish.edges.map(e => (e.from === 'node_modules/@angular/build' && e.requestedName === 'kid' ? { ...e, rawSpec: '^1.0.0' } : e)) }
  const pinnedStart = { ...start, edges: start.edges.map(e => (e.from === 'node_modules/@angular/build' && e.requestedName === 'kid' ? { ...e, rawSpec: '^1.0.0' } : e)) }
  verifyResolution(pinnedStart, pinnedBuild, kid, choices, semver)
  assert.equal(computeCoverage(pinnedStart, pinnedBuild, kid, semver).resolution, 'complete')
})

test('line choices resolve toolchain first, then runtime', () => {
  assertLineOrder([toolchainChoice(), runtimeChoice(), withinRange])
  assertLineOrder([runtimeChoice(), withinRange])
  for (const choices of [[runtimeChoice(), toolchainChoice()], [withinRange, runtimeChoice()], [runtimeChoice(), runtimeChoice()]]) {
    assert.throws(() => assertLineOrder(choices), /^Error: Angular line choices must be resolved first$/)
  }
  assert.equal(ANGULAR_LINES.indexOf(toolchain) < ANGULAR_LINES.indexOf(runtime), true)
})

test('lineManifest rewrites each runtime member in its own field and leaves everything else alone', () => {
  const manifest = {
    dependencies: { '@angular/core': '^2.0.0', '@angular/common': '~2.0.0', '@angular/router': '2.0.0', 'zone.js': '^0.15.0' },
    devDependencies: { '@angular/compiler-cli': '^2.0.0', '@angular/cli': '1.0.0', '@angular/build': '1.0.0' },
  }
  assert.deepEqual(lineManifest(structuredClone(manifest), runtimeChoice(), runtime), {
    dependencies: { '@angular/core': '2.0.1', '@angular/common': '2.0.1', '@angular/router': '2.0.1', 'zone.js': '^0.15.0' },
    devDependencies: { '@angular/compiler-cli': '2.0.1', '@angular/cli': '1.0.0', '@angular/build': '1.0.0' },
  })
})

test('lineManifest updates @angular/platform-browser-dynamic only when an override for it exists', () => {
  const base = () => ({ dependencies: { '@angular/core': '2.0.0' } })
  assert.equal(lineManifest(base(), runtimeChoice(), runtime).overrides, undefined, 'absent: none is added')
  assert.deepEqual(lineManifest({ ...base(), overrides: { other: '1.0.0' } }, runtimeChoice(), runtime).overrides, { other: '1.0.0' })
  assert.deepEqual(lineManifest({ ...base(), overrides: { '@angular/platform-browser-dynamic': '2.0.0', '@angular-devkit/core': '1.0.0' } }, runtimeChoice(), runtime).overrides, { '@angular/platform-browser-dynamic': '2.0.1', '@angular-devkit/core': '1.0.0' })
  assert.deepEqual(lineManifest({ ...base(), overrides: { '@angular/platform-browser-dynamic': { '.': '2.0.0', 'q': '1.0.0' } } }, runtimeChoice(), runtime).overrides, { '@angular/platform-browser-dynamic': { '.': '2.0.1', 'q': '1.0.0' } })
  assert.throws(() => lineManifest({ ...base(), overrides: { '@angular/platform-browser-dynamic': { q: '1.0.0' } } }, runtimeChoice(), runtime), /^Error: Unsupported override scope$/)
  assert.throws(() => lineManifest({ dependencies: { '@angular/common': '2.0.0' } }, runtimeChoice(), runtime), /^Error: Runtime is not declared by the project$/)
})
