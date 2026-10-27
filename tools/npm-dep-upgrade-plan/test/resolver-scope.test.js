import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { matchesSelectedScope, verifyResolution } from '../src/resolver-worker.js'

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

test('scope matching ignores peer-edge metadata changes outside the target installation', () => {
  const selected = { location: 'node_modules/jsdom', requestedName: 'undici', type: 'dependencies' }
  const before = { edges: [
    { from: 'node_modules/jest-preset-angular', to: 'node_modules/jsdom', requestedName: 'jsdom', type: 'peerDependencies', effectiveSpec: '*' },
    { from: 'node_modules/jsdom', to: 'node_modules/undici', requestedName: 'undici', type: 'dependencies', effectiveSpec: '^7.25.0' },
    { from: 'node_modules/@angular/build', to: 'node_modules/undici', requestedName: 'undici', type: 'dependencies', effectiveSpec: '7.29.1' },
  ] }
  const probe = { edges: [
    { ...before.edges[0], effectiveSpec: '29.1.1' },
    { ...before.edges[1], effectiveSpec: '7.30.1' },
    before.edges[2],
  ] }

  assert.equal(matchesSelectedScope(before, probe, 'node_modules/undici', [selected]), true)
})

test('scope matching rejects changes to an unselected consumer of the target installation', () => {
  const selected = { location: 'node_modules/jsdom', requestedName: 'undici', type: 'dependencies' }
  const before = { edges: [
    { from: 'node_modules/jsdom', to: 'node_modules/undici', requestedName: 'undici', type: 'dependencies', effectiveSpec: '^7.25.0' },
    { from: 'node_modules/@angular/build', to: 'node_modules/undici', requestedName: 'undici', type: 'dependencies', effectiveSpec: '7.29.1' },
  ] }
  const probe = { edges: [
    { ...before.edges[0], effectiveSpec: '7.30.1' },
    { ...before.edges[1], effectiveSpec: '7.30.1' },
  ] }

  assert.equal(matchesSelectedScope(before, probe, 'node_modules/undici', [selected]), false)
})

test('scope matching permits a selected consumer to split into a new target installation', () => {
  const selected = { location: 'node_modules/e2e-parent-b', requestedName: 'e2e-target', type: 'dependencies' }
  const before = { edges: [
    { from: 'node_modules/e2e-parent-a', to: 'node_modules/e2e-target', requestedName: 'e2e-target', type: 'dependencies', effectiveSpec: '^6.0.8' },
    { from: 'node_modules/e2e-parent-b', to: 'node_modules/e2e-target', requestedName: 'e2e-target', type: 'dependencies', effectiveSpec: '6.0.9 || ^7.0.0' },
  ] }
  const probe = { edges: [
    before.edges[0],
    { ...before.edges[1], to: 'node_modules/e2e-parent-b/node_modules/e2e-target', effectiveSpec: '7.0.5' },
  ] }

  assert.equal(matchesSelectedScope(before, probe, 'node_modules/e2e-target', [selected]), true)
})

test('scope matching rejects relocating an unselected consumer', () => {
  const selected = { location: 'node_modules/e2e-parent-a', requestedName: 'e2e-target', type: 'dependencies' }
  const before = { edges: [
    { from: 'node_modules/e2e-parent-a', to: 'node_modules/e2e-target', requestedName: 'e2e-target', type: 'dependencies', effectiveSpec: '^6.0.8' },
    { from: 'node_modules/e2e-parent-b', to: 'node_modules/e2e-target', requestedName: 'e2e-target', type: 'dependencies', effectiveSpec: '6.0.9 || ^7.0.0' },
  ] }
  const probe = { edges: [
    { ...before.edges[0], effectiveSpec: '6.0.10' },
    { ...before.edges[1], to: 'node_modules/e2e-parent-b/node_modules/e2e-target' },
  ] }

  assert.equal(matchesSelectedScope(before, probe, 'node_modules/e2e-target', [selected]), false)
})
