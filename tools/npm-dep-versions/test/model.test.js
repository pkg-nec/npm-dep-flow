import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCatalogResponse, normalizeTimestamp } from '../src/model.js'

test('merges only published canonical versions, preserving prereleases and unknown dates', () => {
  assert.deepEqual(normalizeCatalogResponse({ versions: ['1.1.0-beta.1', '1.0.0', '1.0.0', 'v2.0.0'], time: { '1.0.0': '2026-10-01T12:00:00Z', '9.0.0': '2026-01-01T00:00:00Z' } }), [
    { version: '1.0.0', releasedAt: '2026-10-01T12:00:00.000Z' },
    { version: '1.1.0-beta.1', releasedAt: null },
  ])
})
test('accepts combined singleton envelopes and unwrapped versions with missing dates', () => {
  for (const value of [{ versions: '1.0.0', time: null }, [{ versions: ['1.0.0'] }], '1.0.0', ['1.0.0']]) assert.deepEqual(normalizeCatalogResponse(value), [{ version: '1.0.0', releasedAt: null }])
  assert.deepEqual(normalizeCatalogResponse([]), [])
  assert.deepEqual(normalizeCatalogResponse({ versions: [], time: {} }), [])
  assert.deepEqual(normalizeCatalogResponse(['1.0.0+z', '1.0.0+a']).map(r => r.version), ['1.0.0+a', '1.0.0+z'])
})
test('rejects ambiguous or malformed fields rather than guessing membership', () => {
  for (const value of [null, {}, { time: {} }, { versions: 1 }, { versions: ['1.0.0', 2] }, { versions: [], time: [] }, [{ versions: [] }, { versions: [] }]]) assert.throws(() => normalizeCatalogResponse(value), /registry/i)
})
test('rejects invalid calendar dates, offsets and non-timestamps', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-01T12:00:00+25:00', '2026-10-01', null]) assert.equal(normalizeTimestamp(value), null)
  assert.equal(normalizeTimestamp('2024-02-29T01:00:00+01:00'), '2024-02-29T00:00:00.000Z')
})
