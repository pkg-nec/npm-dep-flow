import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { assertLineOrder, computeCoverage, lineManifest, memberEdges, verifyResolution } from '../src/resolver-worker.js'
import { ANGULAR_LINES } from '../src/angular-lines.js'

// The registry holds one line today; a second, synthetic line exercises the multi-line logic.
const [toolchain] = ANGULAR_LINES
const synthetic = { key: 'synthetic', strategy: 'upgrade-synthetic-line', label: 'Upgrade synthetic line', anchor: 'rx', members: ['rx', 'ry'], overrides: ['rx-extra'] }
const LINES = [toolchain, synthetic]

const node = (location, name, version) => ({ location, name, version })
const edge = (from, to, requestedName, rawSpec, extra = {}) => ({ from, to, requestedName, type: 'dependencies', rawSpec, effectiveSpec: rawSpec, valid: true, ...extra })
const rootEdge = (name, version, type = 'devDependencies') => edge('', `node_modules/${name}`, name, version, { type })
const consumerOf = (location, requestedName = 'kid') => ({ location, requestedName, type: 'dependencies' })
const kid = { package: 'kid', version: '1.0.0', targetLocation: 'node_modules/kid', advisories: [{ range: '<1.0.1' }] }
const toolchainChoice = (extra = {}) => ({
  strategy: toolchain.strategy, targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '1.0.0', targetVersion: '1.0.1',
  affectedConsumers: [consumerOf('node_modules/@angular/cli')], ...extra,
})
const syntheticChoice = (extra = {}) => ({
  strategy: synthetic.strategy, targetPackage: 'rx', targetLocation: 'node_modules/rx', currentVersion: '2.0.0', targetVersion: '2.0.1',
  affectedConsumers: [consumerOf('node_modules/rx')], ...extra,
})
const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'kid', targetLocation: 'node_modules/kid', currentVersion: '1.0.0', targetVersion: '1.0.1', affectedConsumers: [consumerOf('node_modules/c')] }

// root -> toolchain members (cli -> kid) and synthetic members (rx -> kid); root -> c.
const treeAt = ({ tc = '1.0.0', syn = '2.0.0', rx = syn, kidVersion = '1.0.0', extraNodes = [], extraEdges = [] } = {}) => ({
  nodes: [
    node('', 'app', '1.0.0'), node('node_modules/@angular/cli', '@angular/cli', tc), node('node_modules/@angular/build', '@angular/build', tc),
    node('node_modules/rx', 'rx', rx), node('node_modules/ry', 'ry', syn), node('node_modules/kid', 'kid', kidVersion), node('node_modules/c', 'c', '1.0.0'),
    ...extraNodes,
  ],
  edges: [
    rootEdge('@angular/cli', tc), rootEdge('@angular/build', tc), rootEdge('rx', syn, 'dependencies'), rootEdge('ry', syn, 'dependencies'), edge('', 'node_modules/c', 'c', '^1.0.0'),
    edge('node_modules/@angular/cli', 'node_modules/kid', 'kid', kidVersion), edge('node_modules/rx', 'node_modules/kid', 'kid', kidVersion),
    ...extraEdges,
  ],
})
const before = treeAt()

test('memberEdges returns the root edges to the members of the given line only', () => {
  assert.deepEqual(memberEdges(before, toolchain).map(e => e.requestedName), ['@angular/cli', '@angular/build'])
  assert.deepEqual(memberEdges(before, synthetic).map(e => e.requestedName), ['rx', 'ry'])
})

test('two accepted line choices verify the members of both lines against the original graph', () => {
  const both = treeAt({ tc: '1.0.1', syn: '2.0.1', kidVersion: '1.0.1' })
  verifyResolution(before, both, kid, [toolchainChoice(), syntheticChoice()], semver, LINES)
  const synOff = treeAt({ tc: '1.0.1', syn: '2.0.1', rx: '2.0.2', kidVersion: '1.0.1' })
  assert.throws(() => verifyResolution(before, synOff, kid, [toolchainChoice(), syntheticChoice()], semver, LINES), /^Error: Synthetic member did not resolve to the tested version$/)
  assert.throws(() => verifyResolution(before, both, kid, [toolchainChoice(), syntheticChoice({ currentVersion: '1.9.0' })], semver, LINES), /^Error: Synthetic installation changed since planning$/)
  assert.throws(() => verifyResolution(before, both, kid, [toolchainChoice({ currentVersion: '0.9.0' }), syntheticChoice()], semver, LINES), /^Error: Toolchain installation changed since planning$/)
})

test('a line choice is verified with the members of its own line only', () => {
  const synOnly = treeAt({ syn: '2.0.1' })
  verifyResolution(before, synOnly, { ...kid, targetLocation: 'node_modules/kid' }, [syntheticChoice({ affectedConsumers: [consumerOf('node_modules/rx')] })], semver, LINES)
  const noSyntheticMembers = { nodes: before.nodes.filter(n => !['rx', 'ry'].includes(n.name)), edges: before.edges.filter(e => !['rx', 'ry'].includes(e.requestedName) && e.from !== 'node_modules/rx') }
  assert.throws(() => verifyResolution(noSyntheticMembers, noSyntheticMembers, kid, [syntheticChoice()], semver, LINES), /^Error: Synthetic installation changed since planning$/)
})

test('a bump of one line may not move the members of another line, even inside its closure', () => {
  // @angular/cli depends on rx, so rx is inside the toolchain closure; the synthetic members still may not move.
  const link = [edge('node_modules/@angular/cli', 'node_modules/rx', 'rx', '^2.0.0')]
  const start = treeAt({ extraEdges: link })
  const moved = treeAt({ tc: '1.0.1', rx: '2.0.1', kidVersion: '1.0.1', extraEdges: link })
  assert.throws(() => verifyResolution(start, moved, kid, [toolchainChoice()], semver, LINES), /^Error: Unrelated installation changed$/)
  verifyResolution(start, moved, kid, [toolchainChoice()], semver, [toolchain])
  verifyResolution(start, treeAt({ tc: '1.0.1', kidVersion: '1.0.1', extraEdges: link }), kid, [toolchainChoice()], semver, LINES)
})

test('the root-member coverage case applies to a member of any line', () => {
  const rx = { package: 'rx', version: '2.0.0', targetLocation: 'node_modules/rx', advisories: [{ range: '<2.0.1' }] }
  const elsewhere = treeAt({ syn: '2.0.1', extraNodes: [node('node_modules/z', 'z', '1.0.0'), node('node_modules/z/node_modules/rx', 'rx', '1.0.0')], extraEdges: [
    edge('node_modules/ry', 'node_modules/z', 'z', '^1.0.0'), edge('node_modules/z', 'node_modules/z/node_modules/rx', 'rx', '1.0.0'), edge('', 'node_modules/z', 'z', '^1.0.0'),
  ] })
  const rootConsumer = { location: '', requestedName: 'rx', type: 'dependencies' }
  assert.deepEqual(computeCoverage(before, elsewhere, rx, semver, LINES).clearedConsumers, [rootConsumer])
  assert.deepEqual(computeCoverage(before, elsewhere, rx, semver, [toolchain]).remainingConsumers, [rootConsumer], 'without the line the root reaches the other copy')
})

test('lineManifest rewrites the declared members of the given line and updates only existing overrides', () => {
  const manifest = { dependencies: { rx: '2.0.0', other: '^1.0.0' }, devDependencies: { 'ry': '2.0.0', '@angular/cli': '1.0.0' }, overrides: { 'rx-extra': '2.0.0', '@angular-devkit/core': '1.0.0' } }
  assert.deepEqual(lineManifest(structuredClone(manifest), syntheticChoice(), synthetic), {
    dependencies: { rx: '2.0.1', other: '^1.0.0' }, devDependencies: { 'ry': '2.0.1', '@angular/cli': '1.0.0' }, overrides: { 'rx-extra': '2.0.1', '@angular-devkit/core': '1.0.0' },
  })
  assert.deepEqual(lineManifest({ dependencies: { rx: '2.0.0' }, overrides: { 'rx-extra': { '.': '2.0.0', 'q': '1.0.0' } } }, syntheticChoice(), synthetic).overrides, { 'rx-extra': { '.': '2.0.1', 'q': '1.0.0' } })
  assert.deepEqual(lineManifest({ dependencies: { rx: '2.0.0' } }, syntheticChoice(), synthetic), { dependencies: { rx: '2.0.1' } })
  assert.throws(() => lineManifest({ dependencies: { rx: '2.0.0' }, overrides: { 'rx-extra': { q: '1.0.0' } } }, syntheticChoice(), synthetic), /^Error: Unsupported override scope$/)
  assert.throws(() => lineManifest({ dependencies: { ry: '2.0.0' } }, syntheticChoice(), synthetic), /^Error: Synthetic is not declared by the project$/)
  assert.throws(() => lineManifest({ dependencies: { rx: '2.0.0' } }, toolchainChoice(), toolchain), /^Error: Toolchain is not declared by the project$/)
})

test('line choices must occupy the first indexes in registry order', () => {
  assertLineOrder([], LINES)
  assertLineOrder([withinRange], LINES)
  assertLineOrder([toolchainChoice(), syntheticChoice(), withinRange], LINES)
  assertLineOrder([syntheticChoice(), withinRange], LINES)
  assertLineOrder([toolchainChoice(), withinRange])
  for (const choices of [[syntheticChoice(), toolchainChoice()], [withinRange, toolchainChoice()], [toolchainChoice(), withinRange, syntheticChoice()], [toolchainChoice(), toolchainChoice()]]) {
    assert.throws(() => assertLineOrder(choices, LINES), /^Error: Angular line choices must be resolved first$/)
  }
  assert.throws(() => assertLineOrder([withinRange, toolchainChoice()]), /^Error: Angular line choices must be resolved first$/)
})

test('a bump of one line that moves another line outside its closure is reported as an unrelated change', () => {
  const moved = treeAt({ tc: '1.0.1', rx: '2.0.1', kidVersion: '1.0.1' })
  assert.throws(() => verifyResolution(before, moved, kid, [toolchainChoice()], semver, LINES), /^Error: Unrelated installation changed$/)
})
