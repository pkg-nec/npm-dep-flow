import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyCoverage } from '../src/coverage.js'
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
