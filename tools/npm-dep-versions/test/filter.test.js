import assert from 'node:assert/strict'
import test from 'node:test'
import { filterRows } from '../src/filter.js'

const rows = ['20.0.0', '19.1.0', '19.1.0-beta.1', '19.0.0', '19.0.0-beta.1', '18.0.0'].map(version => ({ version, releasedAt: null }))
test('stable default and major/range intersection use semantic version bounds', () => {
  assert.deepEqual(filterRows(rows, { all: false, major: 19, range: null }).map(r => r.version), ['19.0.0', '19.1.0'])
  assert.deepEqual(filterRows(rows, { all: true, major: 19, range: '>=19.0.0 <20' }).map(r => r.version), ['19.0.0', '19.1.0-beta.1', '19.1.0'])
  assert.deepEqual(filterRows(rows, { all: true, major: 0, range: null }), [])
  assert.deepEqual(filterRows(rows, { all: false, major: 19, range: '<19' }), [])
  assert.equal(filterRows(rows, { all: true, range: '>=19 <20' })[0].version, '19.0.0-beta.1')
  assert.equal(rows[0].version, '20.0.0')
})
