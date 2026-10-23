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
test('does not mistake a missing or relocated vulnerable dependency for remediation', () => {
  assert.throws(() => verifyCoverage(evidence, { nodes: before.nodes, edges: [before.edges[0]] }), /consumer|requirement/i)
  const after = { nodes: new Map([['moved', { name: 'a', version: '1.2.3' }]]), edges: before.edges.map(e => ({ ...e, to: 'moved' })) }
  assert.equal(verifyCoverage(evidence, after).resolution, 'none')
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
