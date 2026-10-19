import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderJson } from '../src/render.js'

const dependent = (name, version, location, requestedName = 'brace-expansion') => ({
  name, version, location, targetLocation: 'node_modules/brace-expansion',
  type: 'dependencies', requestedName,
})

const rows = [{
  package: 'brace-expansion', version: '5.0.9', severity: 'high',
  advisories: [
    { id: 123, title: 'First issue', url: 'https://github.com/advisories/GHSA-6qxp-vccf-f47h', severity: 'high', range: '<6' },
    { id: 124, title: 'Second issue', url: 'https://example.test/124', severity: 'low', range: '<5.1' },
  ],
  requirements: [
    {
      declaredRequirement: '^5.0.5',
      directDependents: [
        dependent('minimatch', '10.2.5', 'node_modules/minimatch'),
        dependent('minimatch', '10.2.5', 'node_modules/nested/node_modules/minimatch'),
      ],
    },
    {
      declaredRequirement: '5.0.9',
      directDependents: [dependent('nx', '23.1.2', 'node_modules/nx', 'brace-expansion-alias')],
    },
  ],
  paths: ['node_modules/brace-expansion'],
}]

test('shows each declared requirement before its direct dependents', () => {
  const markdown = renderMarkdown(rows)
  assert.match(markdown, /\| Package \| Version \| Highest severity \| Advisories \| Declared requirements \|/)
  assert.match(markdown, /\(\[GHSA-6qxp-vccf-f47h\]\(https:\/\/github\.com\/advisories\/GHSA-6qxp-vccf-f47h\)\) First issue/)
  assert.match(markdown, /\^5\.0\.5 → minimatch@10\.2\.5 \[dependencies\] \(2 installations\)/)
  assert.match(markdown, /5\.0\.9 → nx@23\.1\.2 \[dependencies; requested as brace-expansion-alias\]/)
  assert.equal(markdown.split('\n').filter(line => line.startsWith('| brace-expansion ')).length, 1)
  assert.ok(markdown.endsWith('\n') && !markdown.endsWith('\n\n'))
})

test('uses npm audit severity colors in Markdown', () => {
  for (const [severity, expected] of [
    ['moderate', '<strong style="color: yellow">moderate</strong>'],
    ['high', '<strong style="color: red">high</strong>'],
    ['critical', '<strong style="color: magenta">critical</strong>'],
    ['low', '<strong>low</strong>'],
    ['info', '<strong>info</strong>'],
  ]) {
    assert.ok(renderMarkdown([{ ...rows[0], severity }]).includes(`| ${expected} |`))
  }
})

test('escapes requirement text and dependent labels in Markdown cells', () => {
  const odd = [{
    ...rows[0], package: 'a|b',
    requirements: [{
      declaredRequirement: 'npm:dep@<1|x',
      directDependents: [dependent('parent|x', '1.0.0', 'node_modules/parent', 'dep|alias')],
    }],
  }]
  const markdown = renderMarkdown(odd)
  assert.ok(markdown.includes('a\\|b'))
  assert.ok(markdown.includes('npm:dep@&lt;1\\|x'))
  assert.ok(markdown.includes('parent\\|x@1.0.0'))
  assert.ok(markdown.includes('requested as dep\\|alias'))
})

test('reports no matching advisories for empty rows', () => {
  assert.match(renderMarkdown([]), /No matching direct advisories\./)
})

test('renders stable schema version 2 JSON without the internal paths field', () => {
  const result = JSON.parse(renderJson(rows, '2026-10-09T00:00:00.000Z'))
  assert.equal(result.schemaVersion, 2)
  assert.equal(result.auditedAt, '2026-10-09T00:00:00.000Z')
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['advisories', 'package', 'requirements', 'severity', 'version'])
  assert.deepEqual(result.rows[0].requirements, rows[0].requirements)
  assert.equal(Object.hasOwn(result.rows[0], 'paths'), false)
  assert.ok(renderJson(rows, '2026-10-09T00:00:00.000Z').endsWith('\n'))
})

 test('uses a single report title and omits empty tables', () => {
  assert.ok(renderMarkdown(rows).startsWith('# npm-dep-audit\n\n'))
  assert.equal(renderMarkdown([]), '# npm-dep-audit\n\nNo matching direct advisories.\n')
})
