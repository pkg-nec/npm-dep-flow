import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../src/graph.js'

const project = (dependencies, entries, extra = {}) => ({
  manifest: { name: 'app', version: '1.0.0', dependencies, ...extra },
  lock: { lockfileVersion: 3, packages: {
    '': { name: 'app', version: '1.0.0', dependencies, ...extra },
    ...entries,
  } },
})

test('resolves nested and hoisted dependencies without losing shared edges', () => {
  const graph = buildGraph(project({ a: '1', b: '1' }, {
    'node_modules/a': { version: '1.0.0', dependencies: { dep: '^2' } },
    'node_modules/a/node_modules/dep': { version: '2.1.0' },
    'node_modules/b': { version: '1.0.0', dependencies: { dep: '^1' } },
    'node_modules/dep': { version: '1.5.0' },
  }))
  assert.deepEqual(graph.get('node_modules/a').edges, [{ name: 'dep', type: 'dependencies', spec: '^2', toLocation: 'node_modules/a/node_modules/dep' }])
  assert.deepEqual(graph.get('node_modules/b').edges, [{ name: 'dep', type: 'dependencies', spec: '^1', toLocation: 'node_modules/dep' }])

  const shared = buildGraph(project({ a: '1', b: '1' }, {
    'node_modules/a': { version: '1.0.0', dependencies: { dep: '^1' } },
    'node_modules/b': { version: '1.0.0', dependencies: { dep: '^1' } },
    'node_modules/dep': { version: '1.5.0' },
  }))
  assert.equal(shared.get('node_modules/a').edges[0].toLocation, 'node_modules/dep')
  assert.equal(shared.get('node_modules/b').edges[0].toLocation, 'node_modules/dep')
})

test('resolves peers from an ancestor and retains alias identity and overridden spec', () => {
  const graph = buildGraph(project({ plugin: '1', host: '^2', '@alias/p': 'npm:real@^2', dep: '^1' }, {
    'node_modules/plugin': { version: '1.0.0', peerDependencies: { host: '^2' } },
    'node_modules/host': { version: '2.1.0' },
    'node_modules/@alias/p': { name: 'real', version: '2.2.0' },
    'node_modules/dep': { version: '2.0.0' },
  }))
  assert.deepEqual(graph.get('node_modules/plugin').edges, [{ name: 'host', type: 'peerDependencies', spec: '^2', toLocation: 'node_modules/host' }])
  assert.equal(graph.get('node_modules/@alias/p').name, 'real')
  assert.deepEqual(graph.get('').edges.find(e => e.name === '@alias/p'), { name: '@alias/p', type: 'dependencies', spec: 'npm:real@^2', toLocation: 'node_modules/@alias/p' })
  assert.equal(graph.get('').edges.find(e => e.name === 'dep').spec, '^1')
  assert.equal(graph.get('node_modules/dep').version, '2.0.0')
})

test('allows absent optional and optional peers, with optional precedence', () => {
  const graph = buildGraph(project({ maybe: '^1', plugin: '1' }, {
    'node_modules/plugin': { version: '1.0.0', peerDependencies: { host: '^2' }, peerDependenciesMeta: { host: { optional: true } } },
  }, { optionalDependencies: { maybe: '^1' } }))
  assert.deepEqual(graph.get('').edges.map(e => e.name), ['plugin'])
  assert.deepEqual(graph.get('node_modules/plugin').edges, [])
})

test('rejects missing required and malformed present optional installations', () => {
  assert.throws(() => buildGraph(project({ parent: '1' }, {
    'node_modules/parent': { version: '1.0.0', dependencies: { child: '^2' } },
  })), /parent.*child|child.*parent/)
  assert.throws(() => buildGraph(project({}, {
    'node_modules/maybe': { resolved: 'https://example.test/maybe.tgz' },
  }, { optionalDependencies: { maybe: '^1' } })), /maybe.*version|version.*maybe/)
})

test('uses v2 package locations for resolution', () => {
  const input = project({ parent: '1' }, {
    'node_modules/parent': { version: '1.0.0', dependencies: { child: '^2' } },
    'node_modules/child': { version: '2.0.0' },
  })
  input.lock.lockfileVersion = 2
  assert.equal(buildGraph(input).get('node_modules/parent').edges[0].toLocation, 'node_modules/child')
})
