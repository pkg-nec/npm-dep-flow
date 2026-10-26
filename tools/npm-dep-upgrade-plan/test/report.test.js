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
    resolution: 'complete',
    choices: [{
      strategy: 'update-within-declared-range',
      targetPackage: 'brace-expansion',
      currentVersion: '5.0.9',
      targetVersion: '5.0.12',
      targetLocation: 'node_modules/brace-expansion',
      affectedConsumers: [{ location: 'node_modules/minimatch', requestedName: 'brace-expansion', type: 'dependencies' }],
    }],
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
      resolution: 'none',
      choices: [],
    }),
    row(),
  ])
  const resultRows = markdown.split('\n').filter(line => /^\| [a-f0-9]{7} \| brace-expansion \|/.test(line))

  assert.equal(resultRows.length, 2)
  assert.match(markdown, /\| ID \| Package \| Installed \| Highest severity \| Minimum safe version \| Released at \| Target location \| Resolution \| Strategy \|/)
  assert.match(markdown, /<strong style="color: red">high<\/strong>/)
  assert.match(markdown, /Update within declared range \|/)
  assert.ok(resultRows.some(line => line.includes('| none | — |')))
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
    resolution: 'none',
    choices: [],
  })])

  assert.match(markdown, /bad\\\|pkg/)
  assert.match(markdown, /\| — \| — \| \(project root\) \| none \| — \|/)
})

test('renders a clear empty Markdown report', () => {
  assert.equal(renderMarkdown([]), '# npm-dep-upgrade-plan\n\nNo vulnerable package findings.\n')
})

test('renders schema version 3 resolution and actions without legacy fields', () => {
  const report = JSON.parse(renderJson([row(), row({ targetLocation: 'node_modules/nx/node_modules/brace-expansion', resolution: 'none', choices: [] })], '2026-10-13T06:00:00.000Z'))
  assert.equal(report.schemaVersion, 3)
  assert.equal(report.auditedAt, '2026-10-13T06:00:00.000Z')
  assert.equal(report.rows[0].id, 'ea47178ea641751ab935afac50eb277e52a29d6778025d7ce978b0226d5967b1')
  assert.equal(report.rows[0].resolution, 'complete')
  assert.equal(report.rows[0].choices[0].targetVersion, '5.0.12')
  assert.equal('status' in report.rows[0], false)
  assert.equal('strategy' in report.rows[0], false)
  assert.deepEqual(report.rows[1].choices, [])
  assert.equal('advisories' in report.rows[0], false)
  assert.equal('requirements' in report.rows[0], false)
  assert.equal(JSON.parse(renderJson([], '2026-10-13T06:00:00.000Z')).rows.length, 0)
})

const literalInput = 'a|b [x] *x* _x_ ` \\ <tag>&\n\r\t\x1b\x7f 🌱'
const literalExpected = 'a\\|b \\[x\\] \\*x\\* \\_x\\_ \\` \\\\ &lt;tag&gt;&amp;\\\\n\\\\r\\\\t\\\\x1b\\\\x7f 🌱'

test('renders unusual values literally without changing JSON data', () => {
  const odd = row({ package: literalInput, targetLocation: literalInput })
  const output = renderMarkdown([odd])
  assert.ok(output.includes(`| ${literalExpected} |`), output)
  assert.equal(output.split('\n').filter(line => line.startsWith('|')).length, 3)
  assert.equal([...output].some(char => char !== '\n' && (char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f)), false)
  const json = JSON.parse(renderJson([odd], '2026-10-19T00:00:00.000Z'))
  assert.equal(json.rows[0].package, literalInput)
  assert.equal(json.rows[0].targetLocation, literalInput)
})
