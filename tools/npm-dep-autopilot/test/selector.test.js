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
  const ranked = rankCandidates(entries, 'high', new Set())

  assert.deepEqual(ranked.map(c => c.row.id), ['4', '3', '2', '1', '5'])
  assert.deepEqual(ranked.map(c => c.kind), ['toolchain', 'runtime', 'package', 'package', 'package'])
})

test('a toolchain choice mixed with other choices makes the candidate a toolchain candidate', () => {
  const [candidate] = rankCandidates([entry(web, '1', [WITHIN, TOOLCHAIN])], 'high', new Set())
  assert.equal(candidate.kind, 'toolchain')
})

test('toolchain wins over runtime when both appear', () => {
  const [candidate] = rankCandidates([entry(web, '1', [RUNTIME, TOOLCHAIN])], 'high', new Set())
  assert.equal(candidate.kind, 'toolchain')
})

test('skips are per module and id', () => {
  const entries = [entry(web, '1', [WITHIN]), entry(api, '1', [WITHIN])]
  const ranked = rankCandidates(entries, 'high', new Set([skipKey(web, { id: '1' })]))

  assert.deepEqual(ranked.map(c => c.project.module), ['api'])
})

test('drops partial, none and unknown-severity rows', () => {
  const entries = [
    entry(web, '1', [WITHIN], { resolution: 'partial' }),
    entry(web, '2', [WITHIN], { resolution: 'none' }),
    entry(web, '3', [WITHIN], { severity: 'info' }),
  ]
  assert.deepEqual(rankCandidates(entries, 'high', new Set()), [])
  assert.deepEqual(rankCandidates(entries, 'info', new Set()).length, 0)
})

test('publishesImmediately for critical and Angular candidates only', () => {
  const pkg = { kind: 'package' }
  assert.equal(publishesImmediately('critical', pkg), true)
  assert.equal(publishesImmediately('high', pkg), false)
  assert.equal(publishesImmediately('low', { kind: 'toolchain' }), true)
  assert.equal(publishesImmediately('moderate', { kind: 'runtime' }), true)
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
