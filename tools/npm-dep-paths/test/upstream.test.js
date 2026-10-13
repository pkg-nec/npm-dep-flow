import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSummaryResults } from '../src/summary.js'
import { collectUpstream } from '../src/upstream.js'

const node = (name, version, location, edges = []) => ({ name, version, location, edges })
const edge = (name, toLocation, spec = '^1', type = 'dependencies') => ({ name, type, spec, toLocation })
const exact = (name, version) => ({ kind: 'exact', name, version })

function sharedGraph() {
  return new Map([
    ['', node('app', '1.0.0', '', [edge('a', 'a', '1.0.0'), edge('b', 'b', '1.0.0')])],
    ['a', node('a', '1.0.0', 'a', [edge('mid', 'mid', '^1')])],
    ['b', node('b', '1.0.0', 'b', [edge('mid', 'mid', '^1')])],
    ['mid', node('mid', '1.0.0', 'mid', [edge('minimatch', 'mini', '10.2.5')])],
    ['mini', node('minimatch', '10.2.5', 'mini', [edge('brace-expansion', 'target', '^5.0.5')])],
    ['target', node('brace-expansion', '5.0.9', 'target')],
  ])
}

const resultFor = graph => collectSummaryResults(graph, exact('brace-expansion', '5.0.9'))[0]

test('returns shared upstream nodes and all declared links once', () => {
  const graph = sharedGraph()
  const upstream = collectUpstream(graph, resultFor(graph), exact('minimatch', '10.2.5'))
  assert.deepEqual(upstream.selectedLocations, ['mini'])
  assert.deepEqual(upstream.targetLocations, ['target'])
  assert.deepEqual(upstream.topLevelLocations, ['a', 'b'])
  assert.deepEqual(upstream.nodes.map(item => item.location), ['', 'a', 'b', 'mid', 'mini', 'target'])
  assert.deepEqual(upstream.edges.map(item => [item.from, item.to]), [['', 'a'], ['', 'b'], ['a', 'mid'], ['b', 'mid'], ['mid', 'mini'], ['mini', 'target']])
  assert.deepEqual(upstream.edges.at(-1), { from: 'mini', to: 'target', requestedName: 'brace-expansion', type: 'dependencies', spec: '^5.0.5' })
})

test('filters only the upstream graph through a selected top-level package', () => {
  const graph = sharedGraph()
  const result = resultFor(graph)
  const upstream = collectUpstream(graph, result, exact('minimatch', '10.2.5'), exact('a', '1.0.0'))
  assert.deepEqual(upstream.topLevelLocations, ['a'])
  assert.deepEqual(upstream.nodes.map(item => item.location), ['', 'a', 'mid', 'mini', 'target'])
  assert.deepEqual(upstream.edges.map(item => [item.from, item.to]), [['', 'a'], ['a', 'mid'], ['mid', 'mini'], ['mini', 'target']])
  assert.equal(result.requirements[0].directDependents.length, 1)
  assert.throws(() => collectUpstream(graph, result, exact('minimatch', '10.2.5'), exact('unrelated', '1.0.0')), /top-level|lead|from/i)
})

test('includes every qualifying physical copy of the selected dependent', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('a', 'a'), edge('b', 'b')])],
    ['a', node('a', '1.0.0', 'a', [edge('minimatch', 'mini-a')])],
    ['b', node('b', '1.0.0', 'b', [edge('minimatch', 'mini-b')])],
    ['mini-a', node('minimatch', '10.2.5', 'mini-a', [edge('brace-expansion', 'target', '^5.0.5')])],
    ['mini-b', node('minimatch', '10.2.5', 'mini-b', [edge('brace-expansion', 'target', '^5.0.6')])],
    ['target', node('brace-expansion', '5.0.9', 'target')],
  ])
  const result = resultFor(graph)
  const upstream = collectUpstream(graph, result, exact('minimatch', '10.2.5'))
  assert.deepEqual(upstream.selectedLocations, ['mini-a', 'mini-b'])
  assert.deepEqual(upstream.edges.filter(item => item.to === 'target').map(item => item.spec), ['^5.0.5', '^5.0.6'])
})

test('allows the root itself as the selected direct dependent', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('brace-expansion', 'target', '5.0.9')])],
    ['target', node('brace-expansion', '5.0.9', 'target')],
  ])
  const upstream = collectUpstream(graph, resultFor(graph), exact('app', '1.0.0'))
  assert.deepEqual(upstream.selectedLocations, [''])
  assert.deepEqual(upstream.topLevelLocations, [])
  assert.deepEqual(upstream.nodes.map(item => item.location), ['', 'target'])
  assert.equal(upstream.edges.length, 1)
})

test('represents cycles as finite links and rejects a non-direct dependent', () => {
  const graph = sharedGraph()
  graph.get('mid').edges.push(edge('a', 'a', '^1'))
  const upstream = collectUpstream(graph, resultFor(graph), exact('minimatch', '10.2.5'))
  assert.ok(upstream.edges.some(item => item.from === 'mid' && item.to === 'a'))
  assert.equal(upstream.nodes.length, 6)
  assert.throws(() => collectUpstream(graph, resultFor(graph), exact('mid', '1.0.0')), /direct dependent|does not/i)
})
