import test from 'node:test'
import assert from 'node:assert/strict'

import { attachRequirements } from '../src/requirements.js'

function dependent(name, location, targetLocation, requestedName = 'dep') {
  return { name, version: '1.0.0', location, targetLocation, type: 'dependencies', requestedName }
}

function response() {
  return {
    schemaVersion: 2,
    project: { name: 'fixture', version: '1.0.0' },
    selector: 'dep',
    results: [
      {
        package: 'dep', version: '2.1.7', requirements: [{
          declaredRequirement: '<3',
          directDependents: [dependent('old-parent', 'node_modules/old-parent', 'node_modules/dep-old')],
        }],
      },
      {
        package: 'dep', version: '5.0.9', requirements: [
          {
            declaredRequirement: '^5.0.5',
            directDependents: [
              dependent('minimatch', 'node_modules/minimatch', 'node_modules/dep-a'),
              dependent('minimatch', 'node_modules/nested/node_modules/minimatch', 'node_modules/dep-a'),
              dependent('other', 'node_modules/other', 'node_modules/dep-other'),
            ],
          },
          {
            declaredRequirement: '^5.0.6',
            directDependents: [dependent('legacy-parent', 'node_modules/legacy-parent', 'node_modules/dep-b', 'legacy-dep')],
          },
          {
            declaredRequirement: '^5.0.7',
            directDependents: [dependent('unaffected-parent', 'node_modules/unaffected-parent', 'node_modules/dep-c')],
          },
        ],
      },
      {
        package: 'dep', version: '9.0.0', requirements: [{
          declaredRequirement: '^9',
          directDependents: [dependent('new-parent', 'node_modules/new-parent', 'node_modules/dep-new')],
        }],
      },
    ],
  }
}

const vulnerableRow = {
  package: 'dep', version: '5.0.9', severity: 'high', advisories: [],
  paths: ['node_modules/dep-a', 'node_modules/dep-b'],
}

  test('matches exact versions and keeps only links to audit-affected locations', () => {
    const rows = attachRequirements([vulnerableRow], new Map([['dep', response()]]))
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].requirements.map(group => group.declaredRequirement), ['^5.0.5', '^5.0.6'])
    assert.deepEqual(rows[0].requirements[0].directDependents.map(item => item.location), [
      'node_modules/minimatch',
      'node_modules/nested/node_modules/minimatch',
    ])
    assert.equal(rows[0].requirements[1].directDependents[0].targetLocation, 'node_modules/dep-b')
    assert.equal(rows[0].requirements[1].directDependents[0].requestedName, 'legacy-dep')
    assert.deepEqual(rows[0].paths, vulnerableRow.paths)
  })

  test('rejects an audited version absent from the name-only response', () => {
    const summary = response()
    summary.results = summary.results.filter(result => result.version !== '5.0.9')
    assert.throws(
      () => attachRequirements([vulnerableRow], new Map([['dep', summary]])),
      /did not return dep@5\.0\.9/i,
    )
  })

  test('rejects when an affected installation has no matching direct dependent link', () => {
    const summary = response()
    const result = summary.results.find(item => item.version === '5.0.9')
    for (const group of result.requirements) {
      group.directDependents = group.directDependents.filter(item => item.targetLocation !== 'node_modules/dep-b')
    }
    assert.throws(
      () => attachRequirements([vulnerableRow], new Map([['dep', summary]])),
      /node_modules\/dep-b.*affected location/i,
    )
  })

  test('rejects when the package name has no npm-dep-paths summary', () => {
    assert.throws(
      () => attachRequirements([vulnerableRow], new Map()),
      /npm-dep-paths summary.*dep/i,
    )
  })
