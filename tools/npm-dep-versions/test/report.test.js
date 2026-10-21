import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJson, renderMarkdown } from '../src/report.js'
const report = { schemaVersion: 2, package: 'pkg', fetchedAt: '2026-01-01T00:00:00.000Z', rows: [{ version: '1.0.0+a', releasedAt: null }, { version: '2.0.0', releasedAt: '2026-01-01T00:00:00.000Z' }] }
test('reports preserve JSON values, UTC dates and unknown publication dates', () => {
  assert.deepEqual(JSON.parse(renderJson(report)), report)
  const markdown = renderMarkdown(report)
  assert.match(markdown, /^# npm-dep-versions\n/)
  assert.match(markdown, /1\.0\.0\+a \| —/)
  assert.match(markdown, /2026-01-01 00:00:00\.000 UTC/)
  assert.match(renderMarkdown({ ...report, rows: [] }), /No matching versions/)
  assert.doesNotMatch(renderMarkdown({ ...report, rows: [] }), /\| Version/)
  assert.match(renderMarkdown({ ...report, package: 'a|<b>\n' }), /a\\\|&lt;b&gt;\\\\n/)
})
