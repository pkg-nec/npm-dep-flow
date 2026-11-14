import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { prBody, prPlan } from '../src/naming.js'
import { upgradeReport } from './helpers/fixtures.js'

function appliedItem(overrides = {}) {
  const report = upgradeReport()
  return {
    id: report.id,
    severity: 'high',
    kind: 'package',
    package: report.package,
    oldVersion: report.oldVersion,
    actions: report.actions,
    commits: report.commits.map(commit => commit.subject),
    ...overrides,
  }
}

const angularItem = strategy => appliedItem({
  kind: strategy === 'upgrade-angular-toolchain' ? 'toolchain' : 'runtime',
  package: '@angular/cli',
  actions: [
    { strategy: 'update-within-declared-range', targetPackage: 'other', currentVersion: '1.0.0', targetVersion: '1.0.1', outcome: 'applied' },
    { strategy, targetPackage: '@angular/cli', currentVersion: '20.3.1', targetVersion: '20.3.4', outcome: 'applied' },
  ],
})

test('prBody puts the finding id on each commit line', () => {
  const items = [
    appliedItem({ id: 'a1b2c3d4e5', commits: ['s1', 's2'] }),
    appliedItem({ id: '9f8e7d6c5b', commits: ['s3'] }),
  ]

  assert.equal(prBody(items), '- s1 (a1b2c3d)\n- s2 (a1b2c3d)\n- s3 (9f8e7d6)')
})

test('prPlan still prefers the Angular toolchain and runtime titles', () => {
  assert.deepEqual(prPlan({ module: 'web', items: [angularItem('upgrade-angular-toolchain')], singleFinding: true }), {
    branch: 'deps/web/angular-toolchain-20.3.4',
    title: 'deps(web): bump Angular toolchain to 20.3.4',
  })
  assert.deepEqual(prPlan({ module: 'web', items: [angularItem('upgrade-angular-runtime')], singleFinding: true }), {
    branch: 'deps/web/angular-runtime-20.3.4',
    title: 'deps(web): bump Angular runtime to 20.3.4',
  })
})

test('prPlan uses the per-package title for a single item', () => {
  assert.deepEqual(prPlan({ module: 'web', items: [appliedItem()], singleFinding: false }), {
    branch: 'deps/web/brace-expansion-5.0.12',
    title: 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12',
  })
})

test('prPlan uses the per-package title for several items with one commit in total', () => {
  const items = [appliedItem(), appliedItem({ commits: [] })]

  assert.deepEqual(prPlan({ module: 'web', items, singleFinding: false }), {
    branch: 'deps/web/brace-expansion-5.0.12',
    title: 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12',
  })
})

test('prPlan uses the fix-vulnerabilities title for several items and several commits', () => {
  const items = [appliedItem(), appliedItem(), appliedItem()]

  assert.deepEqual(prPlan({ module: 'web', items, singleFinding: false }), {
    branch: 'deps/web/fix-vulnerabilities',
    title: 'deps(web): fix vulnerabilities',
  })
})

test('a single finding published alone with several commits keeps the package form', () => {
  const plan = prPlan({ module: 'web', items: [appliedItem({ commits: ['one', 'two'] })], singleFinding: true })

  assert.equal(plan.branch, 'deps/web/brace-expansion-5.0.12')
})

test('a drained batch of one finding with several commits uses the fix-vulnerabilities title', () => {
  assert.deepEqual(prPlan({ module: 'web', items: [appliedItem({ commits: ['one', 'two'] })], singleFinding: false }), {
    branch: 'deps/web/fix-vulnerabilities',
    title: 'deps(web): fix vulnerabilities',
  })
})

test('scoped package names produce valid Git branch names', () => {
  const item = appliedItem({
    actions: [{ strategy: 'update-within-declared-range', targetPackage: '@scope/pkg', currentVersion: '1.0.0', targetVersion: '1.2.3', outcome: 'applied' }],
  })
  const plan = prPlan({ module: 'web', items: [item], singleFinding: true })

  assert.equal(plan.branch, 'deps/web/@scope/pkg-1.2.3')
  assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', plan.branch], { stdio: 'pipe' }))
})

test('falls back to package naming when the item has no Angular action', () => {
  const plan = prPlan({ module: 'web', items: [appliedItem({ kind: 'toolchain' })], singleFinding: true })

  assert.equal(plan.branch, 'deps/web/brace-expansion-5.0.12')
})

test('package names with characters Git refs reject are sanitised', () => {
  const item = appliedItem({
    actions: [{ strategy: 'update-within-declared-range', targetPackage: 'we~ird*pkg', currentVersion: '1.0.0', targetVersion: '1.2.3', outcome: 'applied' }],
  })
  const plan = prPlan({ module: 'web', items: [item], singleFinding: true })

  assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', plan.branch], { stdio: 'pipe' }))
})

test('an empty module drops the module from branches and titles', () => {
  const toolchain = prPlan({ module: '', items: [angularItem('upgrade-angular-toolchain')], singleFinding: true })
  const runtime = prPlan({ module: '', items: [angularItem('upgrade-angular-runtime')], singleFinding: true })
  const single = prPlan({ module: '', items: [appliedItem()], singleFinding: false })
  const batch = prPlan({ module: '', items: [appliedItem(), appliedItem()], singleFinding: false })

  assert.deepEqual(toolchain, { branch: 'deps/angular-toolchain-20.3.4', title: 'deps: bump Angular toolchain to 20.3.4' })
  assert.deepEqual(runtime, { branch: 'deps/angular-runtime-20.3.4', title: 'deps: bump Angular runtime to 20.3.4' })
  assert.deepEqual(single, { branch: 'deps/brace-expansion-5.0.12', title: 'deps: bump brace-expansion from 5.0.9 to 5.0.12' })
  assert.deepEqual(batch, { branch: 'deps/fix-vulnerabilities', title: 'deps: fix vulnerabilities' })
})

test('empty-module branch names are valid Git refs', () => {
  const plan = prPlan({ module: '', items: [appliedItem(), appliedItem()], singleFinding: false })

  assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', plan.branch], { stdio: 'pipe' }))
})
