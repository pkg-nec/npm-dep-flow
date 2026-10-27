import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { selectItem, validatePlanner, canonicalLocation, splitLines, splitToolchain } from '../src/planner.js'
import { TOOLCHAIN_STRATEGY } from '../src/model.js'

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

test('planner adapter forwards a clear request and keeps planner failures fatal', async () => {
  const { readPlanner } = await import('../src/planner.js')
  const calls = []
  const run = async (command, args) => {
    calls.push([command, args])
    return { code: 1, stderr: 'cannot clear cache', stdout: '' }
  }
  await assert.rejects(readPlanner('/project', run, { clearCache: true }), /npm-dep-upgrade-plan failed: cannot clear cache/)
  await assert.rejects(readPlanner('/project', run), /failed/)
  assert.deepEqual(calls, [
    ['npm-dep-upgrade-plan', ['.', '--format', 'json', '--clear-cache']],
    ['npm-dep-upgrade-plan', ['.', '--format', 'json']],
  ])
})

test('clear-only adapter asks the planner to clear and reports failures', async () => {
  const { clearPlannerCache } = await import('../src/planner.js')
  const calls = []
  await clearPlannerCache('/project', async (command, args, options) => {
    calls.push([command, args, options])
    return { code: 0, stderr: '', stdout: '' }
  })
  assert.deepEqual(calls, [['npm-dep-upgrade-plan', ['--clear-cache'], { cwd: '/project' }]])
  await assert.rejects(clearPlannerCache('/project', async () => ({ code: 1, stderr: 'cannot clear cache', stdout: '' })), /npm-dep-upgrade-plan --clear-cache failed: cannot clear cache/)
})

const parentLocation = 'node_modules/e2e-parent'
const parent = (extra = {}) => ({ strategy: 'upgrade-via-parent-dependency', targetPackage: 'e2e-parent', targetLocation: parentLocation, currentVersion: '1.0.1', targetVersion: '1.1.0', affectedConsumers: [{ location: parentLocation, requestedName: '@e2e/target', type: 'dependencies' }], ...extra })
const mixed = (choices, resolution = 'partial') => report([{ ...row, resolution, choices }])

test('parent choices validate against the ancestor, not the vulnerable installation', () => {
  const ok = validatePlanner(mixed([parent()]))
  assert.equal(ok.rows[0].choices[0].targetPackage, 'e2e-parent')
  validatePlanner(mixed([row.choices[0], parent({ affectedConsumers: [{ location: 'node_modules/other', requestedName: '@e2e/target', type: 'dependencies' }] })]))
  assert.equal(validatePlanner(mixed([parent({ targetVersion: '1.0.2' })])).rows.length, 1)
})

test('malformed or forged parent choices are rejected', () => {
  for (const choice of [
    parent({ targetPackage: 'Not A Package' }),
    parent({ targetLocation: '../node_modules/e2e-parent' }),
    parent({ targetLocation: location }),
    parent({ currentVersion: 'x' }),
    parent({ targetVersion: '1.0.1' }),
    parent({ targetVersion: '1.0.0' }),
    parent({ affectedConsumers: [] }),
    parent({ affectedConsumers: [{ location: '../bad', requestedName: '@e2e/target', type: 'dependencies' }] }),
    parent({ affectedConsumers: [{ location: parentLocation, requestedName: '@e2e/target', type: 'overrides' }] }),
    parent({ strategy: 'upgrade-via-grandparent' }),
  ]) assert.throws(() => validatePlanner(mixed([choice])), /choice|location|consumer|package/i)
  assert.throws(() => validatePlanner(mixed([parent(), parent({ targetPackage: 'other-parent', targetLocation: 'node_modules/other-parent' })])), /duplicate/i)
})

test('the executor selects parent strategies and still refuses unknown ones', () => {
  assert.equal(selectItem(validatePlanner(mixed([parent()])), id).choices[0].strategy, 'upgrade-via-parent-dependency')
  assert.throws(() => selectItem({ rows: [{ ...row, choices: [{ ...row.choices[0], strategy: 'upgrade-via-grandparent' }] }] }, id), /unsupported/i)
})

test('an ancestor upgrade and a follow-up within-range action may cover the same branch, but not two actions of one strategy', () => {
  const shared = [{ location: parentLocation, requestedName: '@e2e/target', type: 'dependencies' }]
  const within = { ...row.choices[0], affectedConsumers: shared }
  validatePlanner(mixed([within, parent({ affectedConsumers: shared })]))
  assert.throws(() => validatePlanner(mixed([within, { ...within, targetVersion: '6.0.13' }])), /duplicate/i)
  assert.throws(() => validatePlanner(mixed([parent({ affectedConsumers: shared }), parent({ targetPackage: 'other-parent', targetLocation: 'node_modules/other-parent', affectedConsumers: shared })])), /duplicate/i)
})

const toolchain = { strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '19.0.0', targetVersion: '19.2.1', affectedConsumers: [{ location: '', requestedName: '@angular/cli', type: 'devDependencies' }] }
const toolchainRow = (choice = toolchain, extra = []) => ({ ...row, resolution: 'partial', choices: [row.choices[0], ...extra, choice] })
test('the Angular toolchain strategy is accepted, selected and split out', () => {
  assert.equal(TOOLCHAIN_STRATEGY, 'upgrade-angular-toolchain')
  const r = validatePlanner(report([toolchainRow()]))
  const item = selectItem(r, id)
  const { toolchain: found, rest } = splitToolchain(item)
  assert.deepEqual(found, toolchain)
  assert.deepEqual(rest.choices, [row.choices[0]])
  assert.equal(rest.id, id)
  assert.deepEqual(splitToolchain(row), { toolchain: null, rest: row })
})
test('malformed Angular toolchain choices are rejected', () => {
  for (const choice of [
    { ...toolchain, targetVersion: '20.0.0' },
    { ...toolchain, targetVersion: '18.9.0' },
    { ...toolchain, targetVersion: '19.0.0' },
    { ...toolchain, targetPackage: '@angular/core' },
    { ...toolchain, targetLocation: 'node_modules/x/node_modules/@angular/cli' },
    { ...toolchain, currentVersion: 'bad' },
    { ...toolchain, affectedConsumers: [] },
  ]) assert.throws(() => validatePlanner(report([toolchainRow(choice)])), /INVALID_PLAN|choice/i)
  assert.throws(() => validatePlanner(report([toolchainRow(toolchain, [toolchain])])), /INVALID_PLAN|consumer|toolchain/i)
  assert.throws(() => splitToolchain({ ...row, choices: [toolchain, toolchain] }), /toolchain/i)
})

test('splitLines returns line choices in registry order and keeps the rest in order', () => {
  const other = { ...row.choices[0], strategy: 'upgrade-via-parent-dependency' }
  const item = { ...row, choices: [other, toolchain, row.choices[0]] }
  const { lines, rest } = splitLines(item)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].line.name, 'toolchain')
  assert.equal(lines[0].choice, toolchain)
  assert.deepEqual(rest.choices, [other, row.choices[0]])
  assert.equal(rest.id, id)
})
test('splitLines without a line choice returns the item unchanged', () => {
  assert.deepEqual(splitLines(row), { lines: [], rest: row })
})
test('splitLines rejects two choices of one line', () => {
  assert.throws(() => splitLines({ ...row, choices: [toolchain, toolchain] }), error => error.code === 'INVALID_PLAN' && /toolchain/i.test(error.message))
})
