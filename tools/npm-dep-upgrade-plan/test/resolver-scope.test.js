import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { verifyResolution } from '../src/resolver-worker.js'
test('rejects changing another root installation even when the new closure reaches it', () => {
  const before = { nodes: [
    { location: '', name: 'app', version: '1.0.0' },
    { location: 'node_modules/c', name: 'c', version: '1.0.0' },
    { location: 'node_modules/a', name: 'a', version: '7.0.5' },
    { location: 'node_modules/c/node_modules/a', name: 'a', version: '6.0.9' },
  ], edges: [
    { from: '', to: 'node_modules/c', requestedName: 'c', type: 'dependencies', rawSpec: '^1', valid: true },
    { from: '', to: 'node_modules/a', requestedName: 'a', type: 'dependencies', rawSpec: '^6 || ^7', valid: true },
    { from: 'node_modules/c', to: 'node_modules/c/node_modules/a', requestedName: 'a', type: 'dependencies', rawSpec: '^6', valid: true },
  ] }
  const after = { nodes: before.nodes.filter(n => n.location !== 'node_modules/c/node_modules/a').map(n => n.location === 'node_modules/a' ? { ...n, version: '6.0.12' } : n), edges: before.edges.map(e => e.from === 'node_modules/c' ? { ...e, to: 'node_modules/a' } : e) }
  const item = { package: 'a', targetLocation: 'node_modules/c/node_modules/a' }
  const choices = [{ targetVersion: '6.0.12', affectedConsumers: [{ location: 'node_modules/c', requestedName: 'a', type: 'dependencies' }] }]
  assert.throws(() => verifyResolution(before, after, item, choices, semver), /Another target installation changed/)
})
