import assert from 'node:assert/strict'
import test from 'node:test'
import { drainCandidates, publishesImmediately, rankCandidates, skipKey } from '../src/selector.js'
import { choice, plannerRow } from './helpers/fixtures.js'

const web = { module: 'web', path: '/r/web' }
const api = { module: 'api', path: '/r/api' }
const WITHIN = 'update-within-declared-range'
const PARENT = 'upgrade-via-parent-dependency'
const TOOLCHAIN = 'upgrade-angular-toolchain'
const RUNTIME = 'upgrade-angular-runtime'

const entry = (project, id, strategies, overrides = {}) => ({
  project,
  row: plannerRow({ id, choices: strategies.map(choice), ...overrides }),
})

test('ranks complete rows of the severity by strategy then project order', () => {
  const entries = [
    entry(web, '1', [WITHIN]),
    entry(web, '2', [PARENT]),
    entry(api, '3', [RUNTIME]),
    entry(api, '4', [TOOLCHAIN]),
    entry(api, '5', [WITHIN]),
    entry(web, '6', [PARENT], { severity: 'critical' }),
  ]
  const { candidates: ranked } = rankCandidates(entries, 'high', new Set())

  assert.deepEqual(ranked.map(c => c.row.id), ['4', '3', '2', '1', '5'])
  assert.deepEqual(ranked.map(c => c.kind), ['toolchain', 'runtime', 'package', 'package', 'package'])
})

test('a toolchain choice mixed with other choices makes the candidate a toolchain candidate', () => {
  const [candidate] = rankCandidates([entry(web, '1', [WITHIN, TOOLCHAIN])], 'high', new Set()).candidates
  assert.equal(candidate.kind, 'toolchain')
})

test('toolchain wins over runtime when both appear', () => {
  const [candidate] = rankCandidates([entry(web, '1', [RUNTIME, TOOLCHAIN])], 'high', new Set()).candidates
  assert.equal(candidate.kind, 'toolchain')
})

test('skips are per module and id', () => {
  const entries = [entry(web, '1', [WITHIN]), entry(api, '1', [WITHIN])]
  const { candidates: ranked } = rankCandidates(entries, 'high', new Set([skipKey(web, { id: '1' })]))

  assert.deepEqual(ranked.map(c => c.project.module), ['api'])
})

test('drops partial, none and unknown-severity rows', () => {
  const entries = [
    entry(web, '1', [WITHIN], { resolution: 'partial' }),
    entry(web, '2', [WITHIN], { resolution: 'none' }),
    entry(web, '3', [WITHIN], { severity: 'info' }),
  ]
  assert.deepEqual(rankCandidates(entries, 'high', new Set()).candidates, [])
  assert.deepEqual(rankCandidates(entries, 'info', new Set()).candidates.length, 0)
})

test('an ignored row is not a candidate and is reported as ignored', () => {
  const entries = [entry(web, 'a1b2c3', [WITHIN]), entry(web, 'b000', [WITHIN])]
  const { candidates, ignored } = rankCandidates(entries, 'high', new Set(), [{ module: 'web', id: 'a1b2' }])

  assert.deepEqual(candidates.map(c => c.row.id), ['b000'])
  assert.deepEqual(ignored.map(i => i.row.id), ['a1b2c3'])
  assert.equal(ignored[0].project, web)
})

test('an ignore only applies to its own module', () => {
  const entries = [entry(web, 'a1b2c3', [WITHIN]), entry(api, 'a1b2c3', [WITHIN])]
  const { candidates, ignored } = rankCandidates(entries, 'high', new Set(), [{ module: 'api', id: 'a1b2' }])

  assert.deepEqual(candidates.map(c => c.project.module), ['web'])
  assert.deepEqual(ignored.map(i => i.project.module), ['api'])
})

test('a full-length ignore id matches only the identical row id', () => {
  const full = 'a'.repeat(64)
  const entries = [entry(web, full, [WITHIN]), entry(web, `${'a'.repeat(63)}b`, [WITHIN])]
  const { candidates, ignored } = rankCandidates(entries, 'high', new Set(), [{ module: 'web', id: full }])

  assert.deepEqual(ignored.map(i => i.row.id), [full])
  assert.deepEqual(candidates.map(c => c.row.id), [`${'a'.repeat(63)}b`])
})

test('ignored rows are reported even when the severity yields no candidates', () => {
  const entries = [entry(web, 'a1b2c3', [WITHIN])]
  const { candidates, ignored } = rankCandidates(entries, 'high', new Set(), [{ module: 'web', id: 'a1b2' }])

  assert.deepEqual(candidates, [])
  assert.equal(ignored.length, 1)
})

test('a row that is both skipped and ignored is reported as ignored, not dropped silently', () => {
  const entries = [entry(web, 'a1b2c3', [WITHIN])]
  const skip = new Set([skipKey(web, { id: 'a1b2c3' })])
  const { candidates, ignored } = rankCandidates(entries, 'high', skip, [{ module: 'web', id: 'a1b2' }])

  assert.deepEqual(candidates, [])
  assert.deepEqual(ignored.map(i => i.row.id), ['a1b2c3'])
})

test('publishesImmediately is true for a critical item and for any non-package kind', () => {
  assert.equal(publishesImmediately({ severity: 'critical', kind: 'package' }), true)
  assert.equal(publishesImmediately({ severity: 'high', kind: 'package' }), false)
  assert.equal(publishesImmediately({ severity: 'low', kind: 'toolchain' }), true)
  assert.equal(publishesImmediately({ severity: 'moderate', kind: 'runtime' }), true)
})

test('drainCandidates keeps same-module package candidates only', () => {
  const candidates = [
    { project: web, kind: 'package' },
    { project: api, kind: 'package' },
    { project: web, kind: 'toolchain' },
    { project: web, kind: 'runtime' },
  ]
  assert.deepEqual(drainCandidates(candidates, 'web'), [candidates[0]])
})
