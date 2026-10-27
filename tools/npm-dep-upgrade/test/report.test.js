import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJson, renderMarkdown } from '../src/report.js'

test('completed reports identify the selected remediation and verified commit', () => {
  const result = { schemaVersion: 3, id: 'a'.repeat(64), package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12', targetLocation: 'node_modules/e2e-target', strategy: 'update-within-declared-range', releasedAt: '2026-01-01T00:00:00Z', changedFiles: ['package.json', 'package-lock.json'], supportingChanges: [], commit: { hash: 'b'.repeat(40), subject: 'deps: bump e2e-target from 6.0.9 to 6.0.12' } }
  result.resolution = 'complete'
  result.actions = [{ targetPackage: result.package, currentVersion: result.oldVersion, targetVersion: result.newVersion, outcome: 'applied' }]
  result.commits = [result.commit]
  assert.deepEqual(JSON.parse(renderJson(result)), result)
  assert.match(renderMarkdown(result), /^# npm-dep-upgrade\n/)
  assert.match(renderMarkdown(result), /6\.0\.9.*6\.0\.12/)
  assert.match(renderMarkdown(result), /bbbbbbb/)
})

test('Markdown reports preserve control-character and markup escaping', () => {
  const result = { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12', id: 'a'.repeat(64), targetLocation: 'node_modules/e2e-target', changedFiles: ['package-lock.json'], supportingChanges: [], commit: { hash: 'b'.repeat(40), subject: '\u0000\t\n\r\u001f\u007f&<>\\|[]*_`😀' } }
  result.actions = []
  result.commits = [result.commit]
  result.resolution = 'complete'
  const output = renderMarkdown(result)
  assert.ok(output.includes('\\\\x00\\\\x09\\\\x0a\\\\x0d\\\\x1f\\\\x7f&amp;&lt;&gt;\\\\\\|\\[\\]\\*\\_\\`😀'))
  assert.ok(!output.includes(String.fromCharCode(0)))
})

test('reports list the Angular toolchain action row first', () => {
  const result = { schemaVersion: 3, id: 'a'.repeat(64), package: 'e2e-target', oldVersion: '6.0.9', targetLocation: 'node_modules/e2e-target', resolution: 'complete' }
  result.actions = [
    { strategy: 'upgrade-angular-toolchain', targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '21.2.26', targetVersion: '21.2.27', outcome: 'applied' },
    { strategy: 'update-within-declared-range', targetPackage: 'e2e-target', currentVersion: '6.0.9', targetVersion: '6.0.12', outcome: 'already-satisfied' },
  ]
  result.commits = [{ hash: 'b'.repeat(40), subject: 'deps: migrate Angular toolchain to 21.2.27', actionIndex: 0 }]
  assert.deepEqual(JSON.parse(renderJson(result)), result)
  const markdown = renderMarkdown(result)
  assert.match(markdown, /\n@angular\/cli: 21\.2\.26 → 21\.2\.27 \(applied\)\n\ne2e-target: 6\.0\.9 → 6\.0\.12 \(already-satisfied\)\n/)
  assert.match(markdown, /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: deps: migrate Angular toolchain to 21\.2\.27/)
})
