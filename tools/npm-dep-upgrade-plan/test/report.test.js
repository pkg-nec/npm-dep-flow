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

const parentChoice = (name, from, to, location = `node_modules/${name}`) => ({
  strategy: 'upgrade-via-parent-dependency', targetPackage: name, currentVersion: from, targetVersion: to, targetLocation: location,
  affectedConsumers: [{ location, requestedName: 'brace-expansion', type: 'dependencies' }],
})

test('a mixed item lists the within-range label once and each parent transition after it', () => {
  const [within] = row().choices
  const markdown = renderMarkdown([row({ resolution: 'partial', choices: [parentChoice('nx', '23.1.2', '23.2.0'), within, { ...within, targetVersion: '5.0.13' }, parentChoice('@scope/b', '1.0.1', '1.1.0')] })])
  const line = markdown.split('\n').find(item => item.startsWith('| ') && item.includes('brace-expansion |'))
  assert.match(line, /Update within declared range; Upgrade via parent dependency: @scope\/b@1\.0\.1 → @scope\/b@1\.1\.0; Upgrade via parent dependency: nx@23\.1\.2 → nx@23\.2\.0 \|$/)
  assert.doesNotMatch(markdown, /Update within declared range:/)
  assert.equal((markdown.match(/Update within declared range/g) || []).length, 1)
})

test('parent-only items list transitions in deterministic location order regardless of input order', () => {
  const a = parentChoice('b', '1.0.1', '1.1.0')
  const c = parentChoice('c', '2.0.0', '2.1.0')
  const forward = renderMarkdown([row({ choices: [a, c] })])
  const reversed = renderMarkdown([row({ choices: [c, a] })])
  assert.equal(forward, reversed)
  assert.ok(forward.indexOf('b@1.0.1') < forward.indexOf('c@2.0.0'))
  assert.doesNotMatch(forward, /Update within declared range/)
})

test('parent names are escaped and the finding id and JSON choices are unchanged by strategy', () => {
  const markdown = renderMarkdown([row({ choices: [parentChoice('we|ird_pkg', '1.0.0', '1.1.0')] })])
  assert.match(markdown, /Upgrade via parent dependency: we\\\|ird\\_pkg@1\.0\.0 → we\\\|ird\\_pkg@1\.1\.0/)
  const plain = JSON.parse(renderJson([row()], '2026-10-01T00:00:00.000Z')).rows[0]
  const mixed = JSON.parse(renderJson([row({ choices: [...row().choices, parentChoice('nx', '1.0.0', '1.1.0')] })], '2026-10-01T00:00:00.000Z')).rows[0]
  assert.equal(mixed.id, plain.id)
  assert.deepEqual(mixed.choices[1], { strategy: 'upgrade-via-parent-dependency', targetPackage: 'nx', targetLocation: 'node_modules/nx', currentVersion: '1.0.0', targetVersion: '1.1.0', affectedConsumers: [{ location: 'node_modules/nx', requestedName: 'brace-expansion', type: 'dependencies' }] })
})
