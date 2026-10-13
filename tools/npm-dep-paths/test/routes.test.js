import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSelector, collectResults } from '../src/routes.js'

const node = (name, version, location, edges = []) => ({ name, version, location, edges })
const edge = (name, toLocation, spec = '^1', type = 'dependencies') => ({ name, type, spec, toLocation })

test('parses scoped and unscoped names with only exact version suffixes', () => {
  assert.deepEqual(parseSelector('brace-expansion'), { kind: 'name', name: 'brace-expansion' })
  assert.deepEqual(parseSelector('brace-expansion@5.0.9'), { kind: 'exact', name: 'brace-expansion', version: '5.0.9' })
  assert.deepEqual(parseSelector('@scope/name@1.2.3'), { kind: 'exact', name: '@scope/name', version: '1.2.3' })
  assert.deepEqual(parseSelector('@scope/name'), { kind: 'name', name: '@scope/name' })
  for (const invalid of ['', 'foo@^1', '@scope', '@scope/name@latest', 'foo bar']) {
    assert.throws(() => parseSelector(invalid), /selector|version|package/i)
  }
})

test('groups three versions and keeps two routes to one installed version', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('a', 'node_modules/a'), edge('b', 'node_modules/b'), edge('c', 'node_modules/c'), edge('d', 'node_modules/d')])],
    ['node_modules/a', node('a', '1.0.0', 'node_modules/a', [edge('dep', 'node_modules/dep', '^5')])],
    ['node_modules/b', node('b', '1.0.0', 'node_modules/b', [edge('dep', 'node_modules/dep', '5.0.9')])],
    ['node_modules/c', node('c', '1.0.0', 'node_modules/c', [edge('dep', 'node_modules/c/node_modules/dep', '^2')])],
    ['node_modules/d', node('d', '1.0.0', 'node_modules/d', [edge('dep', 'node_modules/d/node_modules/dep', '^1')])],
    ['node_modules/dep', node('dep', '5.0.9', 'node_modules/dep')],
    ['node_modules/c/node_modules/dep', node('dep', '2.1.7', 'node_modules/c/node_modules/dep')],
    ['node_modules/d/node_modules/dep', node('dep', '1.1.21', 'node_modules/d/node_modules/dep')],
  ])
  const all = collectResults(graph, parseSelector('dep'))
  assert.deepEqual(all.map(item => [item.version, item.routeCount]), [['1.1.21', 1], ['2.1.7', 1], ['5.0.9', 2]])
  const exact = collectResults(graph, parseSelector('dep@5.0.9'))
  assert.equal(exact.length, 1)
  assert.deepEqual(exact[0].routes.map(route => route[1].name), ['a', 'b'])
  assert.deepEqual(exact[0].routes.map(route => route.at(-1).incoming.spec), ['^5', '5.0.9'])
  assert.equal(exact[0].routes[0][0].incoming, null)
})

test('selects alias by resolved name', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('alias', 'node_modules/alias', 'npm:real@^2')])],
    ['node_modules/alias', node('real', '2.0.0', 'node_modules/alias')],
  ])
  assert.deepEqual(collectResults(graph, parseSelector('real')).map(item => item.version), ['2.0.0'])
  assert.deepEqual(collectResults(graph, parseSelector('alias')), [])
  assert.equal(collectResults(graph, parseSelector('real'))[0].routes[0][1].incoming.name, 'alias')
})

test('cuts cycles per route without suppressing other valid paths', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('a', 'a'), edge('b', 'b')])],
    ['a', node('a', '1.0.0', 'a', [edge('b', 'b'), edge('dep', 'dep')])],
    ['b', node('b', '1.0.0', 'b', [edge('a', 'a'), edge('dep', 'dep')])],
    ['dep', node('dep', '1.0.0', 'dep')],
  ])
  const result = collectResults(graph, parseSelector('dep@1.0.0'))[0]
  assert.equal(result.routeCount, 4)
  assert.deepEqual(result.routes.map(route => route.map(step => step.name).join('/')), [
    'app/a/b/dep', 'app/a/dep', 'app/b/a/dep', 'app/b/dep',
  ])
})

test('returns an empty list for an absent name and fails an absent exact version', () => {
  const graph = new Map([['', node('app', '1.0.0', '')]])
  assert.deepEqual(collectResults(graph, parseSelector('missing')), [])
  assert.throws(() => collectResults(graph, parseSelector('missing@1.0.0')), /version not found/i)
})

test('selects an exact installed version that contains build metadata', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('dep', 'node_modules/dep')])],
    ['node_modules/dep', node('dep', '1.2.3+build.1', 'node_modules/dep')],
  ])
  assert.deepEqual(parseSelector('dep@1.2.3+build.1'), { kind: 'exact', name: 'dep', version: '1.2.3+build.1' })
  assert.equal(collectResults(graph, parseSelector('dep@1.2.3+build.1'))[0].version, '1.2.3+build.1')
})

test('returns every route when more than a thousand parents share one target', () => {
  const count = 1025
  const rootEdges = []
  const graph = new Map([['target', node('target', '1.0.0', 'target')]])
  for (let i = 0; i < count; i++) {
    const name = `parent-${String(i).padStart(4, '0')}`
    rootEdges.push(edge(name, name))
    graph.set(name, node(name, '1.0.0', name, [edge('target', 'target')]))
  }
  graph.set('', node('app', '1.0.0', '', rootEdges))
  const result = collectResults(graph, parseSelector('target@1.0.0'))[0]
  assert.equal(result.routeCount, count)
  assert.equal(result.routes.at(-1)[1].name, 'parent-1024')
})

test('skips combinatorial branches that cannot reach the selected package', () => {
  let edgeReads = 0
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('target', 'target'), edge('left', '0-left'), edge('right', '0-right')])],
    ['target', node('target', '1.0.0', 'target')],
  ])
  for (let level = 0; level < 16; level++) {
    for (const side of ['left', 'right']) {
      const location = `${level}-${side}`
      const next = level === 15 ? [] : [edge('left', `${level + 1}-left`), edge('right', `${level + 1}-right`)]
      const entry = node(location, '1.0.0', location)
      Object.defineProperty(entry, 'edges', { get() {
        if (++edgeReads > 5000) throw new Error('unrelated branches were enumerated')
        return next
      } })
      graph.set(location, entry)
    }
  }
  const results = collectResults(graph, parseSelector('target@1.0.0'))
  assert.equal(results[0].routeCount, 1)
  assert.ok(edgeReads < 5000)
})
