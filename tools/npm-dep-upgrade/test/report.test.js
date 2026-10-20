import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJson, renderMarkdown } from '../src/report.js'
test('completed reports identify the selected remediation and verified commit', () => {
  const result = { schemaVersion: 2, id: 'a'.repeat(64), package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12', targetLocation: 'node_modules/e2e-target', strategy: 'update-within-declared-range', releasedAt: '2026-01-01T00:00:00Z', changedFiles: ['package.json', 'package-lock.json'], supportingChanges: [], commit: { hash: 'b'.repeat(40), subject: 'deps: bump e2e-target from 6.0.9 to 6.0.12' } }
  assert.deepEqual(JSON.parse(renderJson(result)), result)
  assert.match(renderMarkdown(result), /^# npm-dep-upgrade\n/)
  assert.match(renderMarkdown(result), /6\.0\.9.*6\.0\.12/)
  assert.match(renderMarkdown(result), /bbbbbbb/)
})

test('Markdown reports preserve control-character and markup escaping', () => {
  const result = { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12', id: 'a'.repeat(64), targetLocation: 'node_modules/e2e-target', changedFiles: ['package-lock.json'], supportingChanges: [], commit: { hash: 'b'.repeat(40), subject: '\u0000\t\n\r\u001f\u007f&<>\\|[]*_`😀' } }
  const output = renderMarkdown(result)
  assert.ok(output.includes('\\\\x00\\\\x09\\\\x0a\\\\x0d\\\\x1f\\\\x7f&amp;&lt;&gt;\\\\\\|\\[\\]\\*\\_\\`😀'))
  assert.ok(!output.includes(String.fromCharCode(0)))
})
