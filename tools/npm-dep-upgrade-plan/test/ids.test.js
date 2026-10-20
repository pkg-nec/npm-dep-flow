import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { findingId } from '../src/ids.js'
import { renderJson, renderMarkdown } from '../src/report.js'

test('IDs identify exact package locations independently of version and ordering', () => {
  const location = 'node_modules/minimatch/node_modules/brace-expansion'
  const expected = '73ecbd5d13115b8f46fbe8b4afaff41aa1970264fabd4ef6a296f03ebf25e0fe'
  assert.equal(findingId('brace-expansion', location), expected)
  assert.notEqual(findingId('brace-expansion', 'node_modules/brace-expansion'), expected)
  const scoped = '@e2e/target'
  assert.equal(findingId(scoped, `node_modules/${scoped}`), createHash('sha256').update(`${scoped}__node_modules/${scoped}`).digest('hex'))
  const row = { package: 'brace-expansion', version: '5.0.9', targetLocation: location, severity: 'high', minimumSafeVersion: null, minimumSafeVersionReleasedAt: null, status: 'ineligible', strategy: null }
  assert.equal(JSON.parse(renderJson([row], '2026-10-20T00:00:00.000Z')).rows[0].id, expected)
  assert.equal(JSON.parse(renderJson([{ ...row, version: '5.0.10' }], '2026-10-20T00:00:00.000Z')).rows[0].id, expected)
  assert.match(renderMarkdown([row]), /\| 73ecbd5 \|/)
})
