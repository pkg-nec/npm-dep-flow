import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCoverage, verifyInstalledGraph } from '../src/coverage.js'

const before = { nodes: new Map([['old', { name: 'a', version: '1.2.3' }]]), edges: [{ from: 'b', to: 'old', requestedName: 'a', type: 'dependencies', rawSpec: '1.2.3' }, { from: 'c', to: 'old', requestedName: 'a', type: 'dependencies', rawSpec: '^1.2.0' }] }
const item = { package: 'a', version: '1.2.3', targetLocation: 'old' }
const evidence = { item, graph: before, incoming: before.edges, auditRows: [{ package: 'a', version: '1.2.3', advisories: [{ range: '<1.2.5' }] }] }
test('tracks safe split consumers through new installation locations', () => {
  const after = { nodes: new Map([...before.nodes, ['new', { name: 'a', version: '1.2.5' }]]), edges: [before.edges[0], { ...before.edges[1], to: 'new' }] }
  assert.equal(verifyCoverage(evidence, after).resolution, 'partial')
  assert.equal(verifyCoverage(evidence, after).remainingConsumers[0].location, 'b')
})
test('does not mistake a relocated vulnerable dependency for remediation', () => {
  const after = { nodes: new Map([['moved', { name: 'a', version: '1.2.3' }]]), edges: before.edges.map(e => ({ ...e, to: 'moved' })) }
  assert.equal(verifyCoverage(evidence, after).resolution, 'none')
})
const host = { nodes: new Map([['', { name: 'app', version: '1.0.0' }], ['b', { name: 'b', version: '1.0.1' }], ['c', { name: 'c', version: '1.0.0' }], ['old', { name: 'a', version: '1.2.3' }]]) }
const hosted = { ...host, edges: before.edges }
const hostedEvidence = { ...evidence, graph: hosted, incoming: before.edges }
test('a consumer whose dependency was removed is cleared, even though its edge no longer exists', () => {
  const after = { nodes: host.nodes, edges: [before.edges[1]] }
  const coverage = verifyCoverage(hostedEvidence, after)
  assert.deepEqual(coverage.clearedConsumers.map(c => c.location), ['b'])
  assert.deepEqual(coverage.remainingConsumers.map(c => c.location), ['c'])
  assert.equal(coverage.resolution, 'partial')
})
test('a consumer that left the tree is cleared and one that moved is judged where it now lives', () => {
  const gone = { nodes: new Map([...host.nodes].filter(([location]) => location !== 'b')), edges: [before.edges[1]] }
  assert.deepEqual(verifyCoverage(hostedEvidence, gone).clearedConsumers.map(c => c.location), ['b'])
  const moved = { nodes: new Map([...gone.nodes, ['x/b', { name: 'b', version: '1.1.0' }], ['x/b/a', { name: 'a', version: '1.2.5' }]]), edges: [before.edges[1], { from: 'x/b', to: 'x/b/a', requestedName: 'a', type: 'dependencies', rawSpec: '1.2.5' }] }
  assert.deepEqual(verifyCoverage(hostedEvidence, moved).clearedConsumers.map(c => c.location), ['b'])
  const unsafe = { nodes: new Map([...moved.nodes, ['x/b/a', { name: 'a', version: '1.2.4' }]]), edges: moved.edges }
  assert.deepEqual(verifyCoverage(hostedEvidence, unsafe).clearedConsumers.map(c => c.location), [])
})
test('a descendant that reintroduces the affected version keeps the branch uncleared', () => {
  const after = { nodes: new Map([...host.nodes, ['x', { name: 'x', version: '1.0.0' }]]), edges: [{ from: 'b', to: 'x', requestedName: 'x', type: 'dependencies', rawSpec: '^1' }, { from: 'x', to: 'old', requestedName: 'a', type: 'dependencies', rawSpec: '1.2.3' }, before.edges[1]] }
  assert.equal(verifyCoverage(hostedEvidence, after).resolution, 'none')
})
test('an affected installation the consumer already reached another way is not blamed on the change', () => {
  const start = { nodes: new Map([...host.nodes, ['y', { name: 'y', version: '1.0.0' }], ['y/a', { name: 'a', version: '1.2.1' }]]), edges: [...before.edges, { from: 'b', to: 'y', requestedName: 'y', type: 'dependencies', rawSpec: '^1' }, { from: 'y', to: 'y/a', requestedName: 'a', type: 'dependencies', rawSpec: '1.2.1' }] }
  const finish = { nodes: new Map([...start.nodes, ['b/a', { name: 'a', version: '1.2.5' }]]), edges: [...start.edges.filter(e => !(e.from === 'b' && e.to === 'old')), { from: 'b', to: 'b/a', requestedName: 'a', type: 'dependencies', rawSpec: '1.2.5' }] }
  const hostedStart = { ...evidence, graph: start, incoming: before.edges }
  assert.deepEqual(verifyCoverage(hostedStart, finish).clearedConsumers.map(c => c.location), ['b'])
})
test('a surviving consumer edge must still satisfy its current declaration', () => {
  const after = { nodes: new Map([...host.nodes, ['old', { name: 'a', version: '2.0.0' }]]), edges: before.edges }
  assert.throws(() => verifyCoverage(hostedEvidence, after), /requirement/i)
})
test('installed verification rejects a changed supporting version', () => {
  const expected = { nodes: new Map([['', { name: 'app', version: '1.0.0' }], ['node_modules/helper', { name: 'helper', version: '2.0.0' }]]), edges: [{ from: '', to: 'node_modules/helper', optional: false }] }
  const actual = { ...expected, nodes: new Map([['', expected.nodes.get('')], ['node_modules/helper', { name: 'helper', version: '1.0.0' }]]) }
  assert.throws(() => verifyInstalledGraph(expected, actual), /installed|verified/i)
})
test('installed verification rejects a missing required edge absent from registry metadata', () => {
  const nodes = new Map([['', { name: 'app', version: '1.0.0' }], ['node_modules/a', { name: 'a', version: '1.2.5' }]])
  const rootEdge = { from: '', to: 'node_modules/a', requestedName: 'a', type: 'dependencies', rawSpec: '^1', effectiveSpec: '^1', valid: true, optional: false }
  const expected = { nodes, edges: [rootEdge] }
  const actual = { nodes, edges: [rootEdge, { from: 'node_modules/a', to: null, requestedName: 'helper', type: 'dependencies', rawSpec: '^3', effectiveSpec: '^3', valid: false, optional: false }] }
  assert.throws(() => verifyInstalledGraph(expected, actual), /installed|invalid|required/i)
})
test('another route to the original vulnerable installation keeps the branch uncleared', () => {
  const nodes = new Map([['', { name: 'app', version: '1.0.0' }], ['old', { name: 'a', version: '1.2.3' }]])
  const edges = [{ from: '', to: 'old', requestedName: 'a', type: 'dependencies', rawSpec: '^1.2.0' }, { from: '', to: 'old', requestedName: 'a', type: 'peerDependencies', rawSpec: '1.2.3' }]
  const graph = { nodes, edges }
  assert.equal(verifyCoverage({ item, graph, incoming: edges, auditRows: evidence.auditRows }, graph).resolution, 'none')
})
test('a root consumer is cleared by its own edge even though a sibling consumer keeps the vulnerable copy', () => {
  const edge = (from, to, requestedName, rawSpec) => ({ from, to, requestedName, type: 'dependencies', rawSpec, effectiveSpec: rawSpec, valid: true })
  const startNodes = new Map([['', { name: 'app', version: '1.0.0' }], ['node_modules/a', { name: 'a', version: '1.2.3' }], ['node_modules/b', { name: 'b', version: '1.0.1' }]])
  const startEdges = [edge('', 'node_modules/a', 'a', '^1.2.0'), edge('', 'node_modules/b', 'b', '^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3')]
  const start = { nodes: startNodes, edges: startEdges }
  const split = { nodes: new Map([['', { name: 'app', version: '1.0.0' }], ['node_modules/a', { name: 'a', version: '1.2.5' }], ['node_modules/b', { name: 'b', version: '1.0.1' }], ['node_modules/b/node_modules/a', { name: 'a', version: '1.2.3' }]]), edges: [startEdges[0], startEdges[1], edge('node_modules/b', 'node_modules/b/node_modules/a', 'a', '1.2.3')] }
  const coverage = verifyCoverage({ item, graph: start, incoming: [startEdges[0], startEdges[2]], auditRows: evidence.auditRows }, split)
  assert.deepEqual(coverage.clearedConsumers.map(c => c.location), [''])
  assert.deepEqual(coverage.remainingConsumers.map(c => c.location), ['node_modules/b'])
})
