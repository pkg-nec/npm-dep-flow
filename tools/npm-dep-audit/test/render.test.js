import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderJson } from '../src/render.js'

const rows = [{
  package: 'dep', version: '1.1.1', severity: 'high',
  advisories: [
    { id: 123, title: 'First issue', url: 'https://example.test/123', severity: 'high', range: '<2' },
    { id: 124, title: 'Second issue', url: 'https://example.test/124', severity: 'low', range: '<1.2' },
  ],
  paths: ['node_modules/a/node_modules/dep', 'node_modules/dep'],
}]

test('renders one Markdown row per version with linked advisories and paths', () => {
  const markdown = renderMarkdown(rows)
  assert.match(markdown, /\| Package \| Version \| Highest severity \| Advisories \| Installed paths \|/)
  assert.match(markdown, /\| dep \| 1\.1\.1 \| high \| \[First issue\]\(https:\/\/example\.test\/123\)/)
  assert.match(markdown, /\[Second issue\]\(https:\/\/example\.test\/124\)/)
  assert.match(markdown, /node_modules\/a\/node_modules\/dep<br>node_modules\/dep/)
  assert.equal(markdown.split('\n').filter(line => line.startsWith('| dep ')).length, 1)
  assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'))
})

test('escapes Markdown table metacharacters from audit and lockfile data', () => {
  const odd = [{ ...rows[0], package: 'a|b', advisories: [{ ...rows[0].advisories[0], title: 'Issue [a]|b' }], paths: ['node_modules/a|b'] }]
  const markdown = renderMarkdown(odd)
  assert.ok(markdown.includes('a\\|b'))
  assert.ok(markdown.includes('Issue \\[a\\]\\|b'))
  assert.ok(markdown.includes('node_modules/a\\|b'))
})

test('reports no matching advisories for empty rows', () => {
  assert.match(renderMarkdown([]), /No matching direct advisories\./)
})

test('renders stable versioned JSON with all advisory details', () => {
  const result = JSON.parse(renderJson(rows, '2026-10-09T00:00:00.000Z'))
  assert.deepEqual(result, { schemaVersion: 1, auditedAt: '2026-10-09T00:00:00.000Z', rows })
  assert.ok(renderJson(rows, '2026-10-09T00:00:00.000Z').endsWith('\n'))
})
