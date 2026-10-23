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
