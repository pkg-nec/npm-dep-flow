import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { computeCoverage, verifyResolution } from '../src/resolver-worker.js'

const node = (location, name, version) => ({ location, name, version })
const edge = (from, to, requestedName, rawSpec, extra = {}) => ({ from, to, requestedName, type: 'dependencies', rawSpec, effectiveSpec: rawSpec, valid: true, ...extra })
const item = { package: 'a', version: '1.2.3', targetLocation: 'node_modules/a', advisories: [{ range: '<1.2.5' }] }
const consumerOf = (location, requestedName = 'a', type = 'dependencies') => ({ location, requestedName, type })
const parentChoice = (extra = {}) => ({ strategy: 'upgrade-via-parent-dependency', targetPackage: 'b', targetLocation: 'node_modules/b', currentVersion: '1.0.1', targetVersion: '1.1.0', affectedConsumers: [consumerOf('node_modules/b')], ...extra })

// root -> b (pins a@1.2.3) and root -> c (^1.2.0), both sharing node_modules/a@1.2.3.
const before = {
  nodes: [node('', 'app', '1.0.0'), node('node_modules/a', 'a', '1.2.3'), node('node_modules/b', 'b', '1.0.1'), node('node_modules/c', 'c', '1.0.0')],
  edges: [
    edge('', 'node_modules/b', 'b', '^1.0.0'), edge('', 'node_modules/c', 'c', '^1.0.0'),
    edge('node_modules/b', 'node_modules/a', 'a', '1.2.3'), edge('node_modules/c', 'node_modules/a', 'a', '^1.2.0'),
  ],
}
const withB = (version, edges, extraNodes = []) => ({
  nodes: before.nodes.map(n => (n.location === 'node_modules/b' ? { ...n, version } : n)).concat(extraNodes),
  edges: before.edges.filter(e => e.from !== 'node_modules/b').concat(edges),
})

const safePin = withB('1.1.0', [edge('node_modules/b', 'node_modules/b/node_modules/a', 'a', '1.2.5')], [node('node_modules/b/node_modules/a', 'a', '1.2.5')])
const removal = withB('1.1.0', [])
const reintroduced = withB('1.1.0', [edge('node_modules/b', 'node_modules/x', 'x', '^1.0.0'), edge('node_modules/x', 'node_modules/a', 'a', '1.2.3')], [node('node_modules/x', 'x', '1.0.0')])
const unsafePin = withB('1.1.0', [edge('node_modules/b', 'node_modules/b/node_modules/a', 'a', '1.2.4')], [node('node_modules/b/node_modules/a', 'a', '1.2.4')])

test('a parent that pins a safe version clears its branch while the shared consumer remains', () => {
  verifyResolution(before, safePin, item, [parentChoice()], semver)
  const coverage = computeCoverage(before, safePin, item, semver)
  assert.deepEqual(coverage.clearedConsumers, [consumerOf('node_modules/b')])
  assert.deepEqual(coverage.remainingConsumers, [consumerOf('node_modules/c')])
  assert.equal(coverage.resolution, 'partial')
})

test('removing the dependency clears the branch instead of failing the original-requirement check', () => {
  verifyResolution(before, removal, item, [parentChoice()], semver)
  const coverage = computeCoverage(before, removal, item, semver)
  assert.deepEqual(coverage.clearedConsumers, [consumerOf('node_modules/b')])
  assert.equal(coverage.resolution, 'partial')
})

test('a removed declaration does not clear the branch when a descendant reintroduces the vulnerable installation', () => {
  verifyResolution(before, reintroduced, item, [parentChoice()], semver)
  const coverage = computeCoverage(before, reintroduced, item, semver)
  assert.deepEqual(coverage.clearedConsumers, [])
  assert.equal(coverage.resolution, 'none')
})

test('replacing the dependency with another affected version does not clear the branch', () => {
  verifyResolution(before, unsafePin, item, [parentChoice()], semver)
  assert.equal(computeCoverage(before, unsafePin, item, semver).resolution, 'none')
})

test('a parent upgrade that clears every consumer is complete', () => {
  const all = {
    nodes: [node('', 'app', '1.0.0'), node('node_modules/b', 'b', '1.1.0'), node('node_modules/c', 'c', '1.0.0')],
    edges: [edge('', 'node_modules/b', 'b', '^1.0.0'), edge('', 'node_modules/c', 'c', '^1.0.0')],
  }
  assert.equal(computeCoverage(before, all, item, semver).resolution, 'complete')
})

test('a vulnerable installation the consumer already reached by another route is not blamed on the parent', () => {
  const start = {
    nodes: [...before.nodes, node('node_modules/y', 'y', '1.0.0'), node('node_modules/y/node_modules/a', 'a', '1.2.1')],
    edges: [...before.edges, edge('node_modules/b', 'node_modules/y', 'y', '^1'), edge('node_modules/y', 'node_modules/y/node_modules/a', 'a', '1.2.1')],
  }
  const finish = {
    nodes: start.nodes.map(n => (n.location === 'node_modules/b' ? { ...n, version: '1.1.0' } : n)).concat([node('node_modules/b/node_modules/a', 'a', '1.2.5')]),
    edges: start.edges.filter(e => !(e.from === 'node_modules/b' && e.to === 'node_modules/a')).concat([edge('node_modules/b', 'node_modules/b/node_modules/a', 'a', '1.2.5')]),
  }
  assert.deepEqual(computeCoverage(start, finish, item, semver).clearedConsumers, [consumerOf('node_modules/b')])
})

test('a consumer that was removed from the tree clears its branch; one that moved is judged where it now lives', () => {
  const gone = { nodes: before.nodes.filter(n => n.location !== 'node_modules/b'), edges: before.edges.filter(e => e.from !== 'node_modules/b' && e.to !== 'node_modules/b') }
  assert.deepEqual(computeCoverage(before, gone, item, semver).clearedConsumers, [consumerOf('node_modules/b')])
  const moved = {
    nodes: before.nodes.filter(n => n.location !== 'node_modules/b').concat([node('node_modules/g', 'g', '2.0.0'), node('node_modules/g/node_modules/b', 'b', '1.1.0'), node('node_modules/g/node_modules/b/node_modules/a', 'a', '1.2.5')]),
    edges: before.edges.filter(e => e.from !== 'node_modules/b' && e.to !== 'node_modules/b').concat([
      edge('', 'node_modules/g', 'g', '^2'), edge('node_modules/g', 'node_modules/g/node_modules/b', 'b', '^1'),
      edge('node_modules/g/node_modules/b', 'node_modules/g/node_modules/b/node_modules/a', 'a', '1.2.5'),
    ]),
  }
  assert.deepEqual(computeCoverage(before, moved, item, semver).clearedConsumers, [consumerOf('node_modules/b')])
  const movedUnsafe = { ...moved, nodes: moved.nodes.map(n => (n.name === 'a' && n.location.includes('/g/') ? { ...n, version: '1.2.3' } : n)) }
  assert.deepEqual(computeCoverage(before, movedUnsafe, item, semver).clearedConsumers, [])
})

test('verification rejects a parent that did not land on the tested version', () => {
  assert.throws(() => verifyResolution(before, withB('1.0.2', [edge('node_modules/b', 'node_modules/a', 'a', '1.2.3')]), item, [parentChoice()], semver), /tested version/)
})

test('verification rejects changes to unrelated installations and to other copies of the ancestor', () => {
  const unrelated = { ...safePin, nodes: safePin.nodes.map(n => (n.location === 'node_modules/c' ? { ...n, version: '1.0.9' } : n)) }
  assert.throws(() => verifyResolution(before, unrelated, item, [parentChoice()], semver), /Unrelated|changed/)
  const twoCopies = { nodes: [...before.nodes, node('node_modules/x', 'x', '1.0.0'), node('node_modules/x/node_modules/b', 'b', '1.0.1')], edges: [...before.edges, edge('', 'node_modules/x', 'x', '^1'), edge('node_modules/x', 'node_modules/x/node_modules/b', 'b', '1.0.1')] }
  const changed = { nodes: safePin.nodes.concat([node('node_modules/x', 'x', '1.0.0'), node('node_modules/x/node_modules/b', 'b', '1.1.0')]), edges: safePin.edges.concat([edge('', 'node_modules/x', 'x', '^1'), edge('node_modules/x', 'node_modules/x/node_modules/b', 'b', '1.0.1')]) }
  assert.throws(() => verifyResolution(twoCopies, changed, item, [parentChoice()], semver), /Another ancestor installation changed/)
})

test('a parent upgrade may let npm move the shared installation up to a newer release', () => {
  const deduped = { nodes: safePin.nodes.map(n => (n.location === 'node_modules/a' ? { ...n, version: '1.2.5' } : n)), edges: safePin.edges }
  verifyResolution(before, deduped, item, [parentChoice()], semver)
  assert.deepEqual(computeCoverage(before, deduped, item, semver).clearedConsumers, [consumerOf('node_modules/b'), consumerOf('node_modules/c')])
  assert.equal(computeCoverage(before, deduped, item, semver).resolution, 'complete')
})

test('verification still rejects downgrading an unselected consumer of the target', () => {
  const downgraded = { nodes: safePin.nodes.map(n => (n.location === 'node_modules/a' ? { ...n, version: '1.2.2' } : n)), edges: safePin.edges }
  assert.throws(() => verifyResolution(before, downgraded, item, [parentChoice()], semver), /outside intended scope|not satisfied/)
})

test('verification rejects an invalid resulting graph', () => {
  const invalid = { ...safePin, edges: safePin.edges.map(e => (e.from === 'node_modules/b' ? { ...e, valid: false } : e)) }
  assert.throws(() => verifyResolution(before, invalid, item, [parentChoice()], semver), /Invalid dependency graph/)
})

test('another route to the original vulnerable installation keeps the branch uncleared', () => {
  // The consumer declares the target twice (like a dev and a peer declaration); one edge changes, the other still reaches it.
  const twice = {
    nodes: [node('', 'app', '1.0.0'), node('node_modules/a', 'a', '1.2.3')],
    edges: [edge('', 'node_modules/a', 'a', '^1.2.0'), { ...edge('', 'node_modules/a', 'a', '1.2.3'), type: 'peerDependencies' }],
  }
  assert.deepEqual(computeCoverage(twice, twice, item, semver).clearedConsumers, [])
  assert.equal(computeCoverage(twice, twice, item, semver).resolution, 'none')
})

test('a root consumer is cleared by its own edge even though a sibling consumer keeps the vulnerable copy', () => {
  // root declares a ^1.2.0 and also depends on b, which pins a@1.2.3. After the split the pinned copy lives at b/a.
  const start = {
    nodes: [node('', 'app', '1.0.0'), node('node_modules/a', 'a', '1.2.3'), node('node_modules/b', 'b', '1.0.1')],
    edges: [edge('', 'node_modules/a', 'a', '^1.2.0'), edge('', 'node_modules/b', 'b', '^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3')],
  }
  const split = {
    nodes: [node('', 'app', '1.0.0'), node('node_modules/a', 'a', '1.2.5'), node('node_modules/b', 'b', '1.0.1'), node('node_modules/b/node_modules/a', 'a', '1.2.3')],
    edges: [edge('', 'node_modules/a', 'a', '^1.2.0'), edge('', 'node_modules/b', 'b', '^1.0.0'), edge('node_modules/b', 'node_modules/b/node_modules/a', 'a', '1.2.3')],
  }
  const coverage = computeCoverage(start, split, item, semver)
  assert.deepEqual(coverage.clearedConsumers, [consumerOf('')])
  assert.deepEqual(coverage.remainingConsumers, [consumerOf('node_modules/b')])
  assert.equal(coverage.resolution, 'partial')
})
