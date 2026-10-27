import assert from 'node:assert/strict'
import test from 'node:test'
import { consumerKey, selectWithinRangeChoices, withRootDeclarations } from '../src/coverage.js'
const location = 'node_modules/a'
function row(specs) {
  return { package: 'a', version: '1.2.3', advisories: [{ range: '>=1.2.3 <1.2.5' }], requirements: specs.map(([name, spec, targetLocation = location]) => ({ declaredRequirement: spec, directDependents: [{ name, version: '1.0.0', location: `node_modules/${name}`, targetLocation, requestedName: 'a', type: 'dependencies' }] })) }
}
test('selects caret consumers without forcing pinned consumers', () => {
  const choices = selectWithinRangeChoices(row([['b', '1.2.3'], ['c', '^1.2.0']]), location, ['1.2.5'])
  assert.deepEqual(choices, [{ strategy: 'update-within-declared-range', targetPackage: 'a', targetLocation: location, currentVersion: '1.2.3', targetVersion: '1.2.5', affectedConsumers: [{ location: 'node_modules/c', requestedName: 'a', type: 'dependencies' }] }])
})
test('groups four compatible consumers into one action', () => {
  const choices = selectWithinRangeChoices(row(['b1', 'b2', 'b3', 'b4'].map(n => [n, '1.2.3']).concat(['c1', 'c2', 'c3', 'c4'].map(n => [n, '^1.2.0']))), location, ['1.2.5', '1.2.6'])
  assert.equal(choices.length, 1)
  assert.equal(choices[0].affectedConsumers.length, 4)
  assert.equal(choices[0].targetVersion, '1.2.5')
})
test('covers disjoint ranges deterministically and excludes other installations', () => {
  const choices = selectWithinRangeChoices(row([['b', '<1.2.6'], ['c', '>=1.2.6'], ['d', '^1', 'node_modules/d/node_modules/a']]), location, ['1.2.6', '1.2.5'])
  assert.deepEqual(choices.map(c => [c.targetVersion, c.affectedConsumers.map(x => x.location)]), [['1.2.5', ['node_modules/b']], ['1.2.6', ['node_modules/c']]])
})
test('does not recommend affected, older, prerelease or invalid versions', () => {
  assert.deepEqual(selectWithinRangeChoices(row([['b', '^1']]), location, ['1.2.3', '1.2.4', '1.2.5-beta.1', 'garbage']), [])
  assert.deepEqual(selectWithinRangeChoices(row([['b', 'git:example']]), location, ['1.2.5']), [])
})
test('supports aliases and distinguishes consumer names and declaration fields', () => {
  const r = row([['c', 'npm:a@^1.2.0']])
  r.requirements[0].directDependents[0].requestedName = 'alias'
  assert.equal(selectWithinRangeChoices(r, location, ['1.2.5'])[0].affectedConsumers[0].requestedName, 'alias')
  assert.notEqual(consumerKey({ location: '', requestedName: 'a', type: 'dependencies' }), consumerKey({ location: '', requestedName: 'a', type: 'devDependencies' }))
})
test('root duplicate declarations all constrain the same consumer resolution', () => {
  const r = row([['app', '~1.2.0']])
  Object.assign(r.requirements[0].directDependents[0], { location: '', requestedName: 'a', type: 'devDependencies' })
  const enriched = withRootDeclarations([r], { devDependencies: { a: '~1.2.0' }, peerDependencies: { a: '^1.2.0' } })
  const choices = selectWithinRangeChoices(enriched[0], location, ['1.2.5'])
  assert.deepEqual(choices[0].affectedConsumers.map(c => c.type).sort(), ['devDependencies', 'peerDependencies'])
  assert.equal(r.requirements.length, 1)
})

import { selectResidualChoices } from '../src/coverage.js'

test('residual within-range choices use the declarations the resolved graph now carries', () => {
  const row = { package: 'js-yaml', version: '4.1.0', advisories: [{ range: '<4.3.2' }], requirements: [] }
  const graph = {
    nodes: [{ location: 'node_modules/js-yaml', name: 'js-yaml', version: '4.1.0' }, { location: 'node_modules/mocha', name: 'mocha', version: '10.6.0' }],
    edges: [{ from: 'node_modules/mocha', to: 'node_modules/js-yaml', requestedName: 'js-yaml', type: 'dependencies', rawSpec: '^4.1.0' }],
  }
  const consumer = { location: 'node_modules/mocha', requestedName: 'js-yaml', type: 'dependencies' }
  const catalog = { versions: ['4.1.0', '4.2.0', '4.3.2', '5.0.0'] }
  assert.deepEqual(selectResidualChoices(row, 'node_modules/js-yaml', [consumer], graph, catalog), [{
    strategy: 'update-within-declared-range', targetPackage: 'js-yaml', targetLocation: 'node_modules/js-yaml', currentVersion: '4.1.0', targetVersion: '4.3.2', affectedConsumers: [consumer],
  }])
  const pinned = { ...graph, edges: [{ ...graph.edges[0], rawSpec: '4.1.0' }] }
  assert.deepEqual(selectResidualChoices(row, 'node_modules/js-yaml', [consumer], pinned, catalog), [])
})

test('residual selection skips consumers that no longer reach the package or whose edge is gone', () => {
  const row = { package: 'js-yaml', version: '4.1.0', advisories: [{ range: '<4.3.2' }], requirements: [] }
  const consumer = { location: 'node_modules/mocha', requestedName: 'js-yaml', type: 'dependencies' }
  const gone = { nodes: [], edges: [] }
  assert.deepEqual(selectResidualChoices(row, 'node_modules/js-yaml', [consumer], gone, { versions: ['4.3.2'] }), [])
  const other = {
    nodes: [{ location: 'node_modules/js-yaml', name: 'other-name', version: '1.0.0' }],
    edges: [{ from: 'node_modules/mocha', to: 'node_modules/js-yaml', requestedName: 'js-yaml', type: 'dependencies', rawSpec: '^1' }],
  }
  assert.deepEqual(selectResidualChoices(row, 'node_modules/js-yaml', [consumer], other, { versions: ['4.3.2'] }), [])
})

test('several remaining consumers with different new ranges get the fewest actions that cover them', () => {
  const row = { package: 'a', version: '1.0.0', advisories: [{ range: '<1.2.0' }], requirements: [] }
  const consumers = ['one', 'two', 'three'].map(name => ({ location: `node_modules/${name}`, requestedName: 'a', type: 'dependencies' }))
  const graph = {
    nodes: [{ location: 'node_modules/a', name: 'a', version: '1.0.0' }],
    edges: consumers.map((c, i) => ({ from: c.location, to: 'node_modules/a', requestedName: 'a', type: 'dependencies', rawSpec: ['^1.1.0', '~1.2.0', '^2.0.0'][i] })),
  }
  const choices = selectResidualChoices(row, 'node_modules/a', consumers, graph, { versions: ['1.2.0', '1.2.5', '2.1.0'] })
  assert.deepEqual(choices.map(c => [c.targetVersion, c.affectedConsumers.map(x => x.location)]), [['1.2.0', ['node_modules/one', 'node_modules/two']], ['2.1.0', ['node_modules/three']]])
})
