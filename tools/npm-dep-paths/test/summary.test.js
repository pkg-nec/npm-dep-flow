import test from 'node:test'
import assert from 'node:assert/strict'
import { collectSummaryResults } from '../src/summary.js'

const node = (name, version, location, edges = []) => ({ name, version, location, edges })
const edge = (name, toLocation, spec = '^1', type = 'dependencies') => ({ name, type, spec, toLocation })
const exact = (name, version) => ({ kind: 'exact', name, version })

test('groups verbatim requirements for one resolved version and all direct dependents', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', ['nx', 'mini', 'other', 'second'].map(name => edge(name, name)))],
    ['nx', node('nx', '23.1.2', 'nx', [edge('brace-expansion', 'brace', '5.0.9')])],
    ['mini', node('minimatch', '10.2.5', 'mini', [edge('brace-expansion', 'brace', '^5.0.5')])],
    ['other', node('other-tool', '1.0.0', 'other', [edge('brace-expansion', 'brace', '^5.0.6')])],
    ['second', node('second-tool', '1.0.0', 'second', [edge('brace-expansion', 'brace', '^5.0.5')])],
    ['brace', node('brace-expansion', '5.0.9', 'brace')],
  ])
  const [result] = collectSummaryResults(graph, exact('brace-expansion', '5.0.9'))
  assert.deepEqual(result.requirements.map(group => [group.declaredRequirement, group.directDependents.map(item => item.name)]), [
    ['5.0.9', ['nx']], ['^5.0.5', ['minimatch', 'second-tool']], ['^5.0.6', ['other-tool']],
  ])
  assert.deepEqual(result.requirements[1].directDependents[0], {
    name: 'minimatch', version: '10.2.5', location: 'mini', targetLocation: 'brace', type: 'dependencies', requestedName: 'brace-expansion',
  })
  assert.equal(Object.hasOwn(result, 'routes'), false)
})

test('selects resolved names and keeps root and alias declarations', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('alias', 'alias', 'npm:real@^2', 'devDependencies')])],
    ['alias', node('real', '2.0.0', 'alias')],
  ])
  assert.deepEqual(collectSummaryResults(graph, { kind: 'name', name: 'alias' }), [])
  assert.deepEqual(collectSummaryResults(graph, exact('real', '2.0.0'))[0].requirements[0].directDependents[0], {
    name: 'app', version: '1.0.0', location: '', targetLocation: 'alias', type: 'devDependencies', requestedName: 'alias',
  })
  assert.throws(() => collectSummaryResults(graph, exact('real', '3.0.0')), /version not found/i)
})

test('keeps physical links distinct and orders installed versions', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('a', 'a'), edge('b', 'b'), edge('old', 'old')])],
    ['a', node('parent', '1.0.0', 'a', [edge('dep', 'target-a', '^5')])],
    ['b', node('parent', '1.0.0', 'b', [edge('dep', 'target-b', '^5')])],
    ['old', node('old', '1.0.0', 'old', [edge('dep', 'target-old', '^2')])],
    ['target-a', node('dep', '5.0.9', 'target-a')],
    ['target-b', node('dep', '5.0.9', 'target-b')],
    ['target-old', node('dep', '2.1.7', 'target-old')],
  ])
  const results = collectSummaryResults(graph, { kind: 'name', name: 'dep' })
  assert.deepEqual(results.map(item => item.version), ['2.1.7', '5.0.9'])
  assert.deepEqual(results[1].requirements[0].directDependents.map(item => [item.location, item.targetLocation]), [['a', 'target-a'], ['b', 'target-b']])
})

test('excludes a cycle edge that requires revisiting the target', () => {
  const graph = new Map([
    ['', node('app', '1.0.0', '', [edge('dep', 'dep')])],
    ['dep', node('dep', '1.0.0', 'dep', [edge('late', 'late')])],
    ['late', node('late', '1.0.0', 'late', [edge('dep', 'dep', '^1')])],
  ])
  const [result] = collectSummaryResults(graph, exact('dep', '1.0.0'))
  assert.deepEqual(result.requirements.map(item => item.declaredRequirement), ['^1'])
  assert.deepEqual(result.requirements[0].directDependents.map(item => item.location), [''])
})

test('does not enumerate exponentially many routes through connected diamonds', () => {
  const graph = new Map([['', node('app', '1.0.0', '', [edge('left', '0-left'), edge('right', '0-right')])]])
  for (let level = 0; level < 20; level++) {
    const next = level === 19 ? 'target' : `${level + 1}-left`
    const nextRight = level === 19 ? 'target' : `${level + 1}-right`
    graph.set(`${level}-left`, node('left', '1.0.0', `${level}-left`, [edge('next', next), edge('next', nextRight)]))
    graph.set(`${level}-right`, node('right', '1.0.0', `${level}-right`, [edge('next', next), edge('next', nextRight)]))
  }
  graph.set('target', node('dep', '1.0.0', 'target'))
  const [result] = collectSummaryResults(graph, exact('dep', '1.0.0'))
  assert.equal(result.requirements.length, 1)
  assert.equal(result.requirements[0].directDependents.length, 2)
})
