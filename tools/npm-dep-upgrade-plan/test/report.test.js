import assert from 'node:assert/strict'
import test from 'node:test'
import { renderJson, renderMarkdown, sortFindings } from '../src/report.js'

function link(overrides = {}) {
  return {
    name: 'minimatch',
    version: '10.2.5',
    location: 'node_modules/minimatch',
    targetLocation: 'node_modules/brace-expansion',
    type: 'dependencies',
    requestedName: 'brace-expansion',
    strategies: [{
      id: 'update-within-declared-range',
      status: 'eligible',
      minimumSafeVersion: '5.0.12',
    }],
    ...overrides,
  }
}

function row(overrides = {}) {
  return {
    package: 'brace-expansion',
    version: '5.0.9',
    severity: 'high',
    advisories: [{
      id: 'GHSA-test-1234-abcd',
      title: 'A vulnerability in brace-expansion',
      url: 'https://example.test/advisory',
      severity: 'high',
      range: '<5.0.12',
    }],
    requirements: [{ declaredRequirement: '^5.0.5', directDependents: [link()] }],
    ...overrides,
  }
}

function splitLinkRow(requirement, dependent, strategy) {
  return {
    ...row(),
    requirements: [{
      declaredRequirement: requirement,
      directDependents: [{ ...link(dependent), strategies: [strategy] }],
    }],
  }
}

test('sorts findings by severity, package, and semantic installed version', () => {
  const rows = [
    row({ package: 'zeta', severity: 'low' }),
    row({ package: 'pkg', version: '5.0.9', severity: 'high' }),
    row({ package: 'zeta', severity: 'critical' }),
    row({ package: 'pkg', version: '5.0.12', severity: 'high' }),
    row({ package: 'alpha', severity: 'high' }),
    row({ package: 'beta', severity: 'moderate' }),
    row({ package: 'alpha', severity: 'info' }),
  ]

  assert.deepEqual(sortFindings(rows).map(item => [item.severity, item.package, item.version]), [
    ['critical', 'zeta', '5.0.9'],
    ['high', 'alpha', '5.0.9'],
    ['high', 'pkg', '5.0.9'],
    ['high', 'pkg', '5.0.12'],
    ['moderate', 'beta', '5.0.9'],
    ['low', 'zeta', '5.0.9'],
    ['info', 'alpha', '5.0.9'],
  ])
})

test('sorts requirement groups and physical dependent links deterministically without mutating input', () => {
  const input = row({ requirements: [
    { declaredRequirement: '^5.0.5', directDependents: [
      link({ name: 'zeta', version: '1.0.0', location: 'node_modules/zeta' }),
      link({ name: 'alpha', version: '2.0.0', location: 'node_modules/alpha-2' }),
      link({ name: 'alpha', version: '1.0.0', location: 'node_modules/alpha-1' }),
    ] },
    { declaredRequirement: '5.0.9', directDependents: [link({ name: 'nx', version: '23.1.2' })] },
  ] })
  const sorted = sortFindings([input])[0]

  assert.deepEqual(sorted.requirements.map(group => group.declaredRequirement), ['5.0.9', '^5.0.5'])
  assert.deepEqual(sorted.requirements[1].directDependents.map(item => [item.name, item.version]), [
    ['alpha', '1.0.0'], ['alpha', '2.0.0'], ['zeta', '1.0.0'],
  ])
  assert.equal(input.requirements[0].declaredRequirement, '^5.0.5')
  assert.equal(input.requirements[0].directDependents[0].name, 'zeta')
})

test('renders one Markdown row per physical dependency link with advisories and strategy results', () => {
  const exact = splitLinkRow('5.0.9', {
    name: 'nx', version: '23.1.2', location: 'node_modules/nx',
    targetLocation: 'node_modules/nx/node_modules/brace-expansion',
  }, {
    id: 'update-within-declared-range', status: 'ineligible', reason: 'no-compatible-safe-version',
  })
  const caret = splitLinkRow('^5.0.5', {
    name: 'minimatch', version: '10.2.5', location: 'node_modules/minimatch',
  }, {
    id: 'update-within-declared-range', status: 'eligible', minimumSafeVersion: '5.0.12',
  })
  const markdown = renderMarkdown([exact, caret])
  const resultRows = markdown.split('\n').filter(line => line.startsWith('| brace-expansion |'))

  assert.equal(resultRows.length, 2)
  assert.match(markdown, /\| Requirement \| Direct dependent \| Dependent location \| Target location \| Remediation strategies \|/)
  assert.match(markdown, /\[GHSA-test-1234-abcd\]\(https:\/\/example\.test\/advisory\)/)
  assert.match(markdown, /nx@23\.1\.2/)
  assert.match(markdown, /minimatch@10\.2\.5/)
  assert.ok(markdown.includes('node\\_modules/nx/node\\_modules/brace-expansion'))
  assert.match(markdown, /Update within declared range: eligible; minimum safe version 5\.0\.12/)
  assert.match(markdown, /Update within declared range: ineligible \(no-compatible-safe-version\)/)
  assert.ok(resultRows.some(line => line.includes('| 5.0.9 |') && line.includes('nx@23.1.2')))
  assert.ok(resultRows.some(line => line.includes('| ^5.0.5 |') && line.includes('minimatch@10.2.5')))
})

test('escapes Markdown table values and shows project-root locations clearly', () => {
  const markdown = renderMarkdown([row({
    package: 'bad|pkg',
    requirements: [{
      declaredRequirement: '^1.0.0\n|<tag>*',
      directDependents: [link({
        name: 'parent|name',
        location: '',
        targetLocation: 'node_modules/bad|pkg',
      })],
    }],
  })])

  assert.match(markdown, /bad\\\|pkg/)
  assert.ok(markdown.includes('^1.0.0 \\|&lt;tag&gt;\\*'))
  assert.match(markdown, /parent\\\|name@10\.2\.5/)
  assert.match(markdown, /\(project root\)/)
  assert.ok(markdown.includes('node\\_modules/bad\\|pkg'))
})

test('renders a clear empty Markdown report', () => {
  assert.equal(renderMarkdown([]), '# npm-dep-upgrade-plan\n\nNo vulnerable package findings.\n')
})

test('renders versioned JSON with the original audit fields and ordered per-link strategies', () => {
  const input = [row({ requirements: [
    {
      declaredRequirement: '^5.0.5',
      directDependents: [link({ strategies: [
        { id: 'update-within-declared-range', status: 'eligible', minimumSafeVersion: '5.0.12' },
        { id: 'future-strategy', status: 'ineligible', reason: 'unsupported-requirement' },
      ] })],
    },
  ] })]
  const report = JSON.parse(renderJson(input, '2026-10-13T06:00:00.000Z'))

  assert.deepEqual(report, {
    schemaVersion: 1,
    auditedAt: '2026-10-13T06:00:00.000Z',
    rows: [{
      package: 'brace-expansion',
      version: '5.0.9',
      severity: 'high',
      advisories: [{
        id: 'GHSA-test-1234-abcd',
        title: 'A vulnerability in brace-expansion',
        url: 'https://example.test/advisory',
        severity: 'high',
        range: '<5.0.12',
      }],
      requirements: [{
        declaredRequirement: '^5.0.5',
        directDependents: [{
          name: 'minimatch',
          version: '10.2.5',
          location: 'node_modules/minimatch',
          targetLocation: 'node_modules/brace-expansion',
          type: 'dependencies',
          requestedName: 'brace-expansion',
          strategies: [
            { id: 'update-within-declared-range', status: 'eligible', minimumSafeVersion: '5.0.12' },
            { id: 'future-strategy', status: 'ineligible', reason: 'unsupported-requirement' },
          ],
        }],
      }],
    }],
  })
  assert.equal(renderJson([], '2026-10-13T06:00:00.000Z').includes('"rows": []'), true)
})
