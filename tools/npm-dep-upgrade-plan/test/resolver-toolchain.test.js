import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { computeCoverage, verifyResolution } from '../src/resolver-worker.js'
import { TOOLCHAIN_STRATEGY } from '../src/angular-lines.js'

const node = (location, name, version) => ({ location, name, version })
const edge = (from, to, requestedName, rawSpec, extra = {}) => ({ from, to, requestedName, type: 'dependencies', rawSpec, effectiveSpec: rawSpec, valid: true, ...extra })
const rootEdge = (name, version) => edge('', `node_modules/${name}`, name, version, { type: 'devDependencies' })
const consumerOf = (location, requestedName = 'kid', type = 'dependencies') => ({ location, requestedName, type })
const kid = { package: 'kid', version: '1.0.0', targetLocation: 'node_modules/kid', advisories: [{ range: '<1.0.1' }] }
const toolchainChoice = (extra = {}) => ({
  strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '1.0.0', targetVersion: '1.0.1',
  affectedConsumers: [consumerOf('node_modules/@angular/cli'), consumerOf('node_modules/@angular/build')], ...extra,
})

// root -> @angular/cli@1.0.0 and @angular/build@1.0.0 (both pin kid@1.0.0 and share it), cli -> @angular-devkit/core, root -> c.
const toolchainAt = (version, kidVersion = version, extraNodes = [], extraEdges = []) => ({
  nodes: [
    node('', 'app', '1.0.0'), node('node_modules/@angular/cli', '@angular/cli', version), node('node_modules/@angular/build', '@angular/build', version),
    node('node_modules/@angular-devkit/core', '@angular-devkit/core', version), node('node_modules/kid', 'kid', kidVersion), node('node_modules/c', 'c', '1.0.0'),
    ...extraNodes,
  ],
  edges: [
    rootEdge('@angular/cli', version), rootEdge('@angular/build', version), edge('', 'node_modules/c', 'c', '^1.0.0'),
    edge('node_modules/@angular/cli', 'node_modules/kid', 'kid', kidVersion), edge('node_modules/@angular/build', 'node_modules/kid', 'kid', kidVersion),
    edge('node_modules/@angular/cli', 'node_modules/@angular-devkit/core', '@angular-devkit/core', version),
    ...extraEdges,
  ],
})
const before = toolchainAt('1.0.0')
const bumped = toolchainAt('1.0.1')

test('a toolchain bump may change installations inside the member closures', () => {
  verifyResolution(before, bumped, kid, [toolchainChoice()], semver)
  const coverage = computeCoverage(before, bumped, kid, semver)
  assert.deepEqual(coverage.clearedConsumers, [consumerOf('node_modules/@angular/cli'), consumerOf('node_modules/@angular/build')])
  assert.deepEqual(coverage.remainingConsumers, [])
  assert.equal(coverage.resolution, 'complete')
})

test('a toolchain bump that changes an installation outside the member closures is rejected', () => {
  const added = toolchainAt('1.0.1', '1.0.1', [node('node_modules/z', 'z', '1.0.0')], [edge('node_modules/c', 'node_modules/z', 'z', '^1.0.0')])
  assert.throws(() => verifyResolution(before, added, kid, [toolchainChoice()], semver), /^Error: Unrelated installation changed$/)
  const moved = { ...bumped, nodes: bumped.nodes.map(n => (n.location === 'node_modules/c' ? { ...n, version: '1.0.9' } : n)) }
  assert.throws(() => verifyResolution(before, moved, kid, [toolchainChoice()], semver), /Unrelated/)
})

test('a toolchain member that lands on another version is rejected', () => {
  const offTarget = { ...bumped, nodes: bumped.nodes.map(n => (n.name === '@angular/build' ? { ...n, version: '1.0.2' } : n)) }
  assert.throws(() => verifyResolution(before, offTarget, kid, [toolchainChoice()], semver), /did not resolve to the tested version/)
  const unchanged = { ...bumped, nodes: bumped.nodes.map(n => (n.name === '@angular/cli' ? { ...n, version: '1.0.0' } : n)) }
  assert.throws(() => verifyResolution(before, unchanged, kid, [toolchainChoice()], semver), /did not resolve to the tested version/)
})

test('a toolchain member that moved since planning is rejected', () => {
  assert.throws(() => verifyResolution(before, bumped, kid, [toolchainChoice({ currentVersion: '0.9.0' })], semver), /changed since planning/)
})

test('a toolchain choice may be combined with a within-range choice for another consumer', () => {
  const start = toolchainAt('1.0.0', '1.0.0', [], [edge('node_modules/c', 'node_modules/kid', 'kid', '1.0.0 || ^1.0.2')])
  const nested = ['@angular/cli', '@angular/build'].map(name => `node_modules/${name}/node_modules/kid`)
  const finish = {
    nodes: [...toolchainAt('1.0.1', '1.0.2').nodes, ...nested.map(location => node(location, 'kid', '1.0.1'))],
    edges: [
      ...toolchainAt('1.0.1').edges.filter(e => e.requestedName !== 'kid'),
      ...nested.map(location => edge(location.slice(0, -'/node_modules/kid'.length), location, 'kid', '1.0.1')),
      edge('node_modules/c', 'node_modules/kid', 'kid', '1.0.0 || ^1.0.2'),
    ],
  }
  const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'kid', targetLocation: 'node_modules/kid', currentVersion: '1.0.0', targetVersion: '1.0.2', affectedConsumers: [consumerOf('node_modules/c')] }
  verifyResolution(start, finish, kid, [toolchainChoice(), withinRange], semver)
  assert.equal(computeCoverage(start, finish, kid, semver).resolution, 'complete')
  assert.throws(() => verifyResolution(start, finish, kid, [withinRange], semver), /changed|requirement|scope/i)
})

// The vulnerable installation is @angular/cli itself, declared by the root project.
const cli = { package: '@angular/cli', version: '1.0.0', targetLocation: 'node_modules/@angular/cli', advisories: [{ range: '<1.0.1' }] }
const rootConsumer = { location: '', requestedName: '@angular/cli', type: 'devDependencies' }

test('a root declaration of a vulnerable toolchain member is cleared once the member lands on a safe version', () => {
  const choice = toolchainChoice({ affectedConsumers: [rootConsumer] })
  verifyResolution(before, bumped, cli, [choice], semver)
  const coverage = computeCoverage(before, bumped, cli, semver)
  assert.deepEqual(coverage.clearedConsumers, [rootConsumer])
  assert.deepEqual(coverage.remainingConsumers, [])
  assert.equal(coverage.resolution, 'complete')
})

test('a root declaration of a toolchain member is not blamed for another copy of the member elsewhere in the tree', () => {
  // The new @angular/build brings in x, which carries its own older @angular/cli: another installation, not this branch.
  const elsewhere = toolchainAt('1.0.1', '1.0.1', [node('node_modules/x', 'x', '1.0.0'), node('node_modules/x/node_modules/@angular/cli', '@angular/cli', '0.9.0')], [
    edge('node_modules/@angular/build', 'node_modules/x', 'x', '^1.0.0'), edge('node_modules/x', 'node_modules/x/node_modules/@angular/cli', '@angular/cli', '0.9.0'),
  ])
  const choice = toolchainChoice({ affectedConsumers: [rootConsumer] })
  verifyResolution(before, elsewhere, cli, [choice], semver)
  const coverage = computeCoverage(before, elsewhere, cli, semver)
  assert.deepEqual(coverage.clearedConsumers, [rootConsumer])
  assert.deepEqual(coverage.remainingConsumers, [])
  assert.equal(coverage.resolution, 'complete')
  const unsafe = { ...bumped, nodes: bumped.nodes.map(n => (n.name === '@angular/cli' ? { ...n, version: '1.0.0' } : n)) }
  assert.deepEqual(computeCoverage(before, unsafe, cli, semver).remainingConsumers, [rootConsumer], 'a member still on the affected version is not cleared')
})
