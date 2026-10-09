import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, selectRows } from '../src/rows.js'

const advisory = (id, severity, range) => ({ source: id, title: `Issue ${id}`, url: `https://example.test/${id}`, severity, range })

test('groups paths by exact version and matches advisories to each version', () => {
  const lock = { packages: {
    '': {},
    'node_modules/dep': { version: '1.1.1' },
    'node_modules/a/node_modules/dep': { version: '1.1.1' },
    'node_modules/b/node_modules/dep': { version: '1.1.2' },
  } }
  const audit = { vulnerabilities: { dep: {
    name: 'dep', severity: 'high',
    via: [advisory(1, 'high', '<1.1.3'), advisory(2, 'low', '<1.1.2')],
    nodes: ['node_modules/dep', 'node_modules/a/node_modules/dep', 'node_modules/b/node_modules/dep'],
  } } }
  const rows = buildRows(lock, audit)
  assert.deepEqual(rows.map(row => [row.package, row.version, row.advisories.map(a => a.id)]), [
    ['dep', '1.1.1', [1, 2]],
    ['dep', '1.1.2', [1]],
  ])
  assert.deepEqual(rows[0].paths, ['node_modules/a/node_modules/dep', 'node_modules/dep'])
  assert.equal(rows[0].severity, 'high')
  assert.equal(rows[1].severity, 'high')
})

test('ignores inherited-only findings and resolves alias and scoped names', () => {
  const lock = { packages: {
    '': {},
    'node_modules/alias': { name: 'real-pkg', version: '2.0.0' },
    'node_modules/@scope/actual': { version: '3.0.0' },
    'node_modules/inherited': { version: '4.0.0' },
  } }
  const audit = { vulnerabilities: {
    'real-pkg': { name: 'real-pkg', via: [advisory(3, 'critical', '<3')], nodes: ['node_modules/alias'] },
    '@scope/actual': { name: '@scope/actual', via: [advisory(4, 'moderate', '<4')], nodes: ['node_modules/@scope/actual'] },
    inherited: { name: 'inherited', via: ['real-pkg'], nodes: ['node_modules/inherited'] },
  } }
  assert.deepEqual(buildRows(lock, audit).map(row => row.package), ['@scope/actual', 'real-pkg'])
})

test('minimum severity filters rows and keeps all advisories in a kept row', () => {
  const rows = [
    { package: 'low', version: '1.0.0', severity: 'low', advisories: [{ id: 1 }], paths: [] },
    { package: 'high', version: '1.0.0', severity: 'high', advisories: [{ id: 2 }, { id: 3, severity: 'low' }], paths: [] },
    { package: 'critical', version: '1.0.0', severity: 'critical', advisories: [{ id: 4 }], paths: [] },
  ]
  assert.deepEqual(selectRows(rows, 'high').map(row => row.package), ['critical', 'high'])
  assert.deepEqual(selectRows(rows, 'high')[1].advisories.map(a => a.id), [2, 3])
})

test('rejects unsupported advisory range and missing node version', () => {
  const lock = { packages: { '': {}, 'node_modules/dep': { version: '1.0.0' } } }
  const audit = { vulnerabilities: { dep: { name: 'dep', via: [advisory(1, 'high', 'not a range')], nodes: ['node_modules/dep'] } } }
  assert.throws(() => buildRows(lock, audit), /range/)
  audit.vulnerabilities.dep.via = [advisory(1, 'high', '<2')]
  audit.vulnerabilities.dep.nodes = ['node_modules/missing']
  assert.throws(() => buildRows(lock, audit), /node_modules\/missing/)
})

test('does not turn malformed advisory entries into a clean report', () => {
  const lock = { packages: { '': {}, 'node_modules/dep': { version: '1.0.0' } } }
  const audit = { vulnerabilities: { dep: { via: [null, 42], nodes: ['node_modules/dep'] } } }
  assert.throws(() => buildRows(lock, audit), /via|advisory/i)
})
