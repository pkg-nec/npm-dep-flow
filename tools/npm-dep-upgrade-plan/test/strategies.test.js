import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateFindings } from '../src/evaluate.js'
import { findMinimumSafeVersion, orderedStrategies, updateWithinDeclaredRange } from '../src/strategies.js'

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
const currentStrategy = {
  id: 'update-within-declared-range',
  targetPackage: 'brace-expansion',
  currentVersion: '5.0.9',
  targetVersion: '5.0.12',
}

test('finds the lowest stable safe version newer than the installed version', () => {
  assert.equal(findMinimumSafeVersion(auditRow(), [
    '5.0.8', '5.0.9', '5.0.10-beta.1', '5.0.12', '5.0.13', '6.0.0', 'latest',
  ]), '5.0.12')
})

test('minimum safe version is null when no newer stable release resolves the advisories', () => {
  assert.equal(findMinimumSafeVersion(auditRow(), ['5.0.8', '5.0.9', '5.0.10-beta.1']), null)
})

test('strategy returns a target object for a compatible caret requirement', () => {
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), ['^5.0.5'], versions), currentStrategy)
})

test('strategy rejects an exact pin to the installed vulnerable version', () => {
  assert.equal(updateWithinDeclaredRange(auditRow(), ['5.0.9'], versions), null)
})

test('strategy selects one version satisfying every requirement at a location', () => {
  const available = ['5.0.9', '5.0.12', '5.0.13', '6.0.0']
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), ['^5.0.5', '>=5.0.12 <5.1.0'], available), currentStrategy)
  assert.equal(updateWithinDeclaredRange(auditRow(), ['^5.0.5', '5.0.9'], available), null)
})

test('strategy picks the lowest safe release accepted by all requirements', () => {
  const available = ['5.0.9', '5.0.12', '5.0.13', '6.0.0']
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), ['^5.0.13 || ^6.0.0'], available), {
    ...currentStrategy,
    targetVersion: '5.0.13',
  })
})

test('safe versions must fall outside every advisory range', () => {
  const row = auditRow({ advisories: [
    { range: '<5.0.12' },
    { range: '>=5.0.15 <5.0.20' },
  ] })
  assert.equal(findMinimumSafeVersion(row, ['5.0.9', '5.0.12', '5.0.16', '5.0.20']), '5.0.12')
})

test('strategy supports matching npm aliases and rejects non-range or mismatched aliases', () => {
  assert.deepEqual(updateWithinDeclaredRange(auditRow(), ['npm:brace-expansion@^5.0.5'], versions), currentStrategy)
  assert.equal(updateWithinDeclaredRange(auditRow(), ['latest'], versions), null)
  assert.equal(updateWithinDeclaredRange(auditRow(), ['npm:other-package@^5.0.5'], versions), null)
})

test('evaluation keeps separate installations separate with global safe metadata', () => {
  const row = auditRow({ requirements: [
    { declaredRequirement: '5.0.9', directDependents: [dependent({ name: 'nx', targetLocation: 'node_modules/nx/node_modules/brace-expansion' })] },
    { declaredRequirement: '^5.0.5', directDependents: [dependent()] },
  ] })
  const evaluated = evaluateFindings([row], new Map([['brace-expansion', { versions, releaseTimes: new Map([['5.0.12', '2026-10-01T12:00:00.000Z']]) }]]))
  assert.deepEqual(evaluated.map(r => [r.targetLocation, r.resolution, r.choices.length]), [
    ['node_modules/nx/node_modules/brace-expansion', 'none', 0], ['node_modules/brace-expansion', 'complete', 1],
  ])
  assert.equal(evaluated[0].minimumSafeVersionReleasedAt, '2026-10-01T12:00:00.000Z')
  assert.equal(evaluated[1].minimumSafeVersion, '5.0.12')
})
test('one installation gets a partial action for compatible consumers', () => {
  const row = auditRow({ requirements: [
    { declaredRequirement: '5.0.9', directDependents: [dependent({ name: 'nx', location: 'node_modules/nx' })] },
    { declaredRequirement: '^5.0.5', directDependents: [dependent()] },
  ] })
  const evaluated = evaluateFindings([row], new Map([['brace-expansion', versions]]))
  assert.equal(evaluated.length, 1)
  assert.equal(evaluated[0].resolution, 'partial')
  assert.deepEqual(evaluated[0].choices[0].affectedConsumers, [{ location: 'node_modules/minimatch', requestedName: 'brace-expansion', type: 'dependencies' }])
  assert.equal(evaluated[0].minimumSafeVersionReleasedAt, null)
})
test('strategy ordering still starts with within-range remediation', () => {
  assert.deepEqual(orderedStrategies.map(s => [s.id, s.order]), [['update-within-declared-range', 1]])
})
