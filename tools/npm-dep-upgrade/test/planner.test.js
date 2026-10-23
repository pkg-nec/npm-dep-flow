import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { selectItem, validatePlanner, canonicalLocation } from '../src/planner.js'
const location = 'node_modules/@e2e/target'
const id = createHash('sha256').update('@e2e/target__' + location).digest('hex')
const row = { id, package: '@e2e/target', version: '6.0.9', targetLocation: location, severity: 'high', minimumSafeVersion: '6.0.10', minimumSafeVersionReleasedAt: '2026-01-01T00:00:00.000Z', resolution: 'complete', choices: [{ strategy: 'update-within-declared-range', targetPackage: '@e2e/target', targetLocation: location, currentVersion: '6.0.9', targetVersion: '6.0.10', affectedConsumers: [{ location: '', requestedName: '@e2e/target', type: 'dependencies' }] }] }
const report = rows => ({ schemaVersion: 3, auditedAt: '2026-10-20T00:00:00.000Z', rows })
test('planner validates IDs and selects one exact package/location', () => {
  const r = validatePlanner(report([row]))
  assert.equal(selectItem(r, id.slice(0, 7), '@e2e/target').targetLocation, location)
  assert.throws(() => selectItem(r, id, 'different-package'), /not found/i)
  assert.throws(() => validatePlanner(report([{ ...row, id: 'a'.repeat(64) }])), /ID/i)
  assert.throws(() => validatePlanner(report([row, row])), /duplicate/i)
  assert.throws(() => selectItem(report([{ ...row, resolution: 'none', choices: [] }]), id), /ineligible/i)
})
test('location validation excludes alternate spellings and escapes', () => {
  assert.equal(canonicalLocation(location), location)
  for (const value of ['', '/node_modules/a', '../node_modules/a', './node_modules/a', 'node_modules/../a', 'node_modules/a/', 'node_modules\\a', 'node_modules/a/extra', 'node_modules//a']) assert.throws(() => canonicalLocation(value), /location/i)
})
test('H05 adapter controls reject missing IDs, unknown strategy, failed or malformed planner', async () => {
  const { readPlanner } = await import('../src/planner.js')
  const missing = { ...row }
  delete missing.id
  assert.throws(() => validatePlanner(report([missing])), /ID/i)
  assert.throws(() => selectItem(report([{ ...row, choices: [{ ...row.choices[0], strategy: 'upgrade-parent' }] }]), id), /unsupported/i)
  await assert.rejects(readPlanner('/project', async () => ({ code: 1, stderr: 'fixture error', stdout: '' })), /failed/i)
  await assert.rejects(readPlanner('/project', async () => ({ code: 0, stderr: '', stdout: 'invalid' })), /JSON/i)
  // Controlled duplicate: hypothetical full-collision handling, not a real SHA collision.
  assert.throws(() => validatePlanner(report([row, { ...row }])), /Duplicate full/i)
})

test('rejects legacy schemas and malformed or overlapping action scopes', () => {
  assert.throws(() => validatePlanner({ ...report([row]), schemaVersion: 2 }), /schema/i)
  for (const choice of [
    { ...row.choices[0], targetPackage: 'wrong' },
    { ...row.choices[0], affectedConsumers: [] },
    { ...row.choices[0], affectedConsumers: [{ location: '../bad', requestedName: 'a', type: 'dependencies' }] },
  ]) assert.throws(() => validatePlanner(report([{ ...row, choices: [choice] }])), /choice|location/i)
  assert.throws(() => validatePlanner(report([{ ...row, choices: [row.choices[0], row.choices[0]] }])), /consumer|duplicate/i)
  assert.equal(selectItem(report([{ ...row, resolution: 'partial' }]), id).resolution, 'partial')
})
