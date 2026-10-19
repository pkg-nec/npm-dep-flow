import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJson, renderMarkdown, sortFindings } from '../src/report.js'

function row(overrides = {}) {
  return {
    package: 'brace-expansion',
    version: '5.0.9',
    targetLocation: 'node_modules/brace-expansion',
    severity: 'high',
    minimumSafeVersion: '5.0.12',
    minimumSafeVersionReleasedAt: '2026-10-01T12:00:00.000Z',
    status: 'eligible',
    strategy: {
      id: 'update-within-declared-range',
      targetPackage: 'brace-expansion',
      currentVersion: '5.0.9',
      targetVersion: '5.0.12',
    },
    ...overrides,
  }
}

test('sorts flattened findings by severity, package, version, and target location', () => {
  const rows = [
    row({ package: 'zeta', severity: 'low' }),
    row({ package: 'pkg', version: '5.0.9', severity: 'high' }),
    row({ package: 'zeta', severity: 'critical' }),
    row({ package: 'pkg', version: '5.0.12', severity: 'high' }),
    row({ package: 'alpha', severity: 'high' }),
    row({ package: 'beta', severity: 'moderate' }),
    row({ package: 'alpha', severity: 'info' }),
    row({ package: 'alpha', severity: 'high', targetLocation: 'node_modules/z/brace-expansion' }),
    row({ package: 'alpha', severity: 'high', targetLocation: 'node_modules/a/brace-expansion' }),
  ]

  assert.deepEqual(sortFindings(rows).map(item => [item.severity, item.package, item.version, item.targetLocation]), [
    ['critical', 'zeta', '5.0.9', 'node_modules/brace-expansion'],
    ['high', 'alpha', '5.0.9', 'node_modules/a/brace-expansion'],
    ['high', 'alpha', '5.0.9', 'node_modules/brace-expansion'],
    ['high', 'alpha', '5.0.9', 'node_modules/z/brace-expansion'],
    ['high', 'pkg', '5.0.9', 'node_modules/brace-expansion'],
    ['high', 'pkg', '5.0.12', 'node_modules/brace-expansion'],
    ['moderate', 'beta', '5.0.9', 'node_modules/brace-expansion'],
    ['low', 'zeta', '5.0.9', 'node_modules/brace-expansion'],
    ['info', 'alpha', '5.0.9', 'node_modules/brace-expansion'],
  ])
})

test('renders one Markdown row per package version and target location', () => {
  const markdown = renderMarkdown([
    row({
      targetLocation: 'node_modules/nx/node_modules/brace-expansion',
      status: 'ineligible',
      strategy: null,
    }),
    row(),
  ])
  const resultRows = markdown.split('\n').filter(line => line.startsWith('| brace-expansion |'))

  assert.equal(resultRows.length, 2)
  assert.match(markdown, /\| Package \| Installed \| Highest severity \| Minimum safe version \| Released at \| Target location \| Status \| Strategy \|/)
  assert.match(markdown, /<strong style="color: red">high<\/strong>/)
  assert.match(markdown, /Update within declared range: brace-expansion@5\.0\.9 → brace-expansion@5\.0\.12/)
  assert.ok(resultRows.some(line => line.includes('| ineligible | — |')))
  assert.ok(resultRows.some(line => line.includes('node\\_modules/nx/node\\_modules/brace-expansion')))
  assert.doesNotMatch(markdown, /Advisories|Requirement|Direct dependent/)
})

test('escapes Markdown values and renders null versions and project-root locations', () => {
  const markdown = renderMarkdown([row({
    package: 'bad|pkg',
    version: '1.0.0',
    targetLocation: '',
    minimumSafeVersion: null,
    minimumSafeVersionReleasedAt: null,
    status: 'ineligible',
    strategy: null,
  })])

  assert.match(markdown, /bad\\\|pkg/)
  assert.match(markdown, /\| — \| — \| \(project root\) \| ineligible \| — \|/)
})

test('renders a clear empty Markdown report', () => {
  assert.equal(renderMarkdown([]), '# npm-dep-upgrade-plan\n\nNo vulnerable package findings.\n')
})

test('renders schema version 2 rows without audit details', () => {
  const ineligible = row({
    targetLocation: 'node_modules/nx/node_modules/brace-expansion',
    status: 'ineligible',
    strategy: null,
  })
  const report = JSON.parse(renderJson([row(), ineligible], '2026-10-13T06:00:00.000Z'))

  assert.deepEqual(report, {
    schemaVersion: 2,
    auditedAt: '2026-10-13T06:00:00.000Z',
    rows: [
      {
        package: 'brace-expansion',
        version: '5.0.9',
        targetLocation: 'node_modules/brace-expansion',
        severity: 'high',
        minimumSafeVersion: '5.0.12',
        minimumSafeVersionReleasedAt: '2026-10-01T12:00:00.000Z',
        status: 'eligible',
        strategy: {
          id: 'update-within-declared-range',
          targetPackage: 'brace-expansion',
          currentVersion: '5.0.9',
          targetVersion: '5.0.12',
        },
      },
      {
        package: 'brace-expansion',
        version: '5.0.9',
        targetLocation: 'node_modules/nx/node_modules/brace-expansion',
        severity: 'high',
        minimumSafeVersion: '5.0.12',
        minimumSafeVersionReleasedAt: '2026-10-01T12:00:00.000Z',
        status: 'ineligible',
        strategy: null,
      },
    ],
  })
  assert.equal('advisories' in report.rows[0], false)
  assert.equal('requirements' in report.rows[0], false)
  assert.equal(renderJson([], '2026-10-13T06:00:00.000Z').includes('"rows": []'), true)
})

const literalInput = 'a|b [x] *x* _x_ ` \\ <tag>&\n\r\t\x1b\x7f 🌱'
const literalExpected = 'a\\|b \\[x\\] \\*x\\* \\_x\\_ \\` \\\\ &lt;tag&gt;&amp;\\\\n\\\\r\\\\t\\\\x1b\\\\x7f 🌱'

test('renders unusual values literally without changing JSON data', () => {
  const odd = row({ package: literalInput, targetLocation: literalInput })
  const output = renderMarkdown([odd])
  assert.ok(output.includes(`| ${literalExpected} |`), output)
  assert.equal(output.split('\n').filter(line => line.startsWith('|')).length, 3)
  assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f]/)
  const json = JSON.parse(renderJson([odd], '2026-10-19T00:00:00.000Z'))
  assert.equal(json.rows[0].package, literalInput)
  assert.equal(json.rows[0].targetLocation, literalInput)
})
