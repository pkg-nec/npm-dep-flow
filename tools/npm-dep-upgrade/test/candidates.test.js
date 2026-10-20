import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCandidate } from '../src/candidates.js'
const now = Date.parse('2026-10-20T00:00:00Z'), day = 86400000
const item = { version: '6.0.9', minimumSafeVersion: '6.0.10', package: 'e2e-target' }
const versions = ['6.0.9', '6.0.10', '6.0.12', '6.0.13', '6.0.14-beta.1', '6.1.0', '7.0.5']
const catalog = { versions, releaseTimes: new Map(versions.map(v => [v, new Date(now - (v === '6.0.13' ? 1 : 30) * day).toISOString()])) }
test('newest safe release respects all ranges, timestamps, and candidate-only advisories', () => {
  const advisories = [{ range: '<6.0.10' }, { range: '6.0.12' }]
  assert.equal(selectCandidate(item, ['^6.0.8', '~6.0.8'], catalog, [], now).version, '6.0.12')
  assert.equal(selectCandidate(item, ['^6.0.8'], catalog, advisories, now).version, '6.1.0')
  assert.equal(selectCandidate(item, ['~6.0.8'], catalog, advisories, now).version, '6.0.10')
  assert.throws(() => selectCandidate(item, ['6.0.9'], catalog, [], now), /candidate|eligible/i)
})
test('seven-day boundary is inclusive and missing/future timestamps never pass', () => {
  const c = { versions: ['6.0.12'], releaseTimes: new Map([['6.0.12', new Date(now - 7 * day).toISOString()]]) }
  assert.equal(selectCandidate(item, ['^6.0.8'], c, [], now).version, '6.0.12')
  for (const stamp of [new Date(now - 7 * day + 1).toISOString(), new Date(now + day).toISOString(), null, 'invalid']) {
    c.releaseTimes.set('6.0.12', stamp)
    assert.throws(() => selectCandidate(item, ['^6.0.8'], c, [], now), /candidate|eligible/i)
  }
})
