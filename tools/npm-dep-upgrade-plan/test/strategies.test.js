import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateFindings } from '../src/evaluate.js'
import { orderedStrategies, updateWithinDeclaredRange } from '../src/strategies.js'

function auditRow(overrides = {}) {
  return {
    package: 'brace-expansion',
    version: '5.0.9',
    severity: 'high',
    advisories: [{ range: '<5.0.12' }],
    requirements: [],
    ...overrides,
  }
}

function dependent(overrides = {}) {
  return {
    name: 'minimatch',
    version: '10.2.5',
    location: 'node_modules/minimatch',
    targetLocation: 'node_modules/brace-expansion',
    type: 'dependencies',
    requestedName: 'brace-expansion',
    ...overrides,
  }
}

const versions = ['5.0.9', '5.0.12']

test('strategy allows a caret requirement and reports the lowest safe version', () => {
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), '^5.0.5', versions), {
    id: 'update-within-declared-range',
    status: 'eligible',
    minimumSafeVersion: '5.0.12',
  })
})

test('strategy rejects an exact pin to the installed vulnerable version', () => {
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), '5.0.9', versions), {
    id: 'update-within-declared-range',
    status: 'ineligible',
    reason: 'no-compatible-safe-version',
  })
})

for (const requirement of ['~5.0.5', '>=5.0.5 <5.1.0', '^4.0.0 || ^5.0.5']) {
  test(`strategy accepts a valid semver range: ${requirement}`, () => {
    assert.equal(updateWithinDeclaredRange(auditRow(), requirement, versions).minimumSafeVersion, '5.0.12')
  })
}

test('strategy chooses a later safe version admitted by a union', () => {
  const available = ['5.0.9', '5.0.12', '5.0.13', '6.0.0']
  const result = updateWithinDeclaredRange(auditRow(), '^5.0.13 || ^6.0.0', available)
  assert.equal(result.status, 'eligible')
  assert.equal(result.minimumSafeVersion, '5.0.13')
})

test('strategy chooses a candidate outside every advisory range', () => {
  const row = auditRow({ advisories: [
    { range: '<5.0.12' },
    { range: '>=5.0.15 <5.0.20' },
  ] })
  const result = updateWithinDeclaredRange(row, '>=5.0.12 <5.1.0', [
    '5.0.9', '5.0.12', '5.0.16', '5.0.20',
  ])
  assert.equal(result.status, 'eligible')
  assert.equal(result.minimumSafeVersion, '5.0.12')
})

test('strategy skips versions that are not newer than the installed version', () => {
  const row = auditRow({ advisories: [{ range: '<5.0.8' }] })
  const result = updateWithinDeclaredRange(row, '>=5.0.0', ['5.0.8', '5.0.9', '5.0.12'])
  assert.equal(result.minimumSafeVersion, '5.0.12')
})

test('strategy supports a matching unscoped npm alias', () => {
  assert.equal(
    updateWithinDeclaredRange(auditRow(), 'npm:brace-expansion@^5.0.5', versions).minimumSafeVersion,
    '5.0.12',
  )
})

test('strategy supports a matching scoped npm alias', () => {
  const row = auditRow({ package: '@scope/brace-expansion' })
  assert.equal(
    updateWithinDeclaredRange(row, 'npm:@scope/brace-expansion@^5.0.5', versions).minimumSafeVersion,
    '5.0.12',
  )
})

for (const [requirement, packageName] of [
  ['latest', 'brace-expansion'],
  ['git+https://example.test/brace-expansion.git', 'brace-expansion'],
  ['npm:other-package@^5.0.5', 'brace-expansion'],
  ['npm:@other/brace-expansion@^5.0.5', '@scope/brace-expansion'],
  ['npm:brace-expansion', 'brace-expansion'],
]) {
  test(`strategy reports an unsupported requirement: ${requirement}`, () => {
    const row = auditRow({ package: packageName })
    assert.deepEqual(updateWithinDeclaredRange(row, requirement, versions), {
      id: 'update-within-declared-range',
      status: 'ineligible',
      reason: 'unsupported-requirement',
    })
  })
}

test('strategy reports no compatible candidate when the requirement admits none', () => {
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), '^6.0.0', versions), {
    id: 'update-within-declared-range',
    status: 'ineligible',
    reason: 'no-compatible-safe-version',
  })
})

test('evaluation preserves separate exact and caret links for one vulnerable version', () => {
  const row = auditRow({
    requirements: [
      { declaredRequirement: '5.0.9', directDependents: [dependent({ name: 'nx', version: '23.1.2' })] },
      { declaredRequirement: '^5.0.5', directDependents: [dependent()] },
    ],
  })
  const evaluated = evaluateFindings([row], new Map([['brace-expansion', versions]]))
  const links = evaluated[0].requirements.flatMap(group => group.directDependents)

  assert.equal(links.length, 2)
  assert.deepEqual(links.map(link => [link.name, link.version, link.strategies[0].status]), [
    ['nx', '23.1.2', 'ineligible'],
    ['minimatch', '10.2.5', 'eligible'],
  ])
  assert.equal(links[1].strategies[0].minimumSafeVersion, '5.0.12')
  assert.equal('strategies' in row.requirements[0].directDependents[0], false)
})

test('evaluation calls injected strategies in ascending order', () => {
  const calls = []
  const strategies = [
    { id: 'second', label: 'Second', order: 2, evaluate: () => { calls.push('second'); return { id: 'second' } } },
    { id: 'first', label: 'First', order: 1, evaluate: () => { calls.push('first'); return { id: 'first' } } },
  ]
  const row = auditRow({ requirements: [{ declaredRequirement: '^5', directDependents: [dependent()] }] })
  const result = evaluateFindings([row], new Map(), strategies)

  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(result[0].requirements[0].directDependents[0].strategies, [
    { id: 'first' }, { id: 'second' },
  ])
  assert.deepEqual(orderedStrategies.map(strategy => [strategy.id, strategy.order]), [
    ['update-within-declared-range', 1],
  ])
})
