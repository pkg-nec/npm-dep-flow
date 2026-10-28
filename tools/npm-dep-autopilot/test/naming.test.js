import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { prPlan } from '../src/naming.js'
import { upgradeReport } from './helpers/fixtures.js'

const angularReport = strategy => upgradeReport({
  package: '@angular/cli',
  actions: [
    { strategy: 'update-within-declared-range', targetPackage: 'other', currentVersion: '1.0.0', targetVersion: '1.0.1', outcome: 'applied' },
    { strategy, targetPackage: '@angular/cli', currentVersion: '20.3.1', targetVersion: '20.3.4', outcome: 'applied' },
  ],
})

test('names an Angular toolchain PR from the anchor action', () => {
  assert.deepEqual(prPlan({ module: 'web', kind: 'toolchain', reports: [angularReport('upgrade-angular-toolchain')], singleFinding: true }), {
    branch: 'deps/web/angular-toolchain-20.3.4',
    title: 'deps(web): bump Angular toolchain to 20.3.4',
  })
})

test('names an Angular runtime PR from the anchor action', () => {
  assert.deepEqual(prPlan({ module: 'web', kind: 'runtime', reports: [angularReport('upgrade-angular-runtime')], singleFinding: true }), {
    branch: 'deps/web/angular-runtime-20.3.4',
    title: 'deps(web): bump Angular runtime to 20.3.4',
  })
})

test('names a single-package PR from the first action', () => {
  assert.deepEqual(prPlan({ module: 'web', kind: 'package', reports: [upgradeReport()], singleFinding: false }), {
    branch: 'deps/web/brace-expansion-5.0.12',
    title: 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12',
  })
})

test('names a multi-commit batch fix-vulnerabilities', () => {
  const reports = [upgradeReport(), upgradeReport(), upgradeReport()]
  assert.deepEqual(prPlan({ module: 'web', kind: 'package', reports, singleFinding: false }), {
    branch: 'deps/web/fix-vulnerabilities',
    title: 'deps(web): fix vulnerabilities',
  })
})

test('a single finding with several commits keeps the package form', () => {
  const report = upgradeReport({ commits: [{ hash: 'a' }, { hash: 'b' }] })
  const plan = prPlan({ module: 'web', kind: 'package', reports: [report], singleFinding: true })

  assert.equal(plan.branch, 'deps/web/brace-expansion-5.0.12')
})

test('scoped package names produce valid Git branch names', () => {
  const report = upgradeReport({
    actions: [{ strategy: 'update-within-declared-range', targetPackage: '@scope/pkg', currentVersion: '1.0.0', targetVersion: '1.2.3', outcome: 'applied' }],
  })
  const plan = prPlan({ module: 'web', kind: 'package', reports: [report], singleFinding: true })

  assert.equal(plan.branch, 'deps/web/@scope/pkg-1.2.3')
  assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', plan.branch], { stdio: 'pipe' }))
})

test('falls back to package naming when the report has no Angular action', () => {
  const report = upgradeReport()
  const plan = prPlan({ module: 'web', kind: 'toolchain', reports: [report], singleFinding: true })

  assert.equal(plan.branch, 'deps/web/brace-expansion-5.0.12')
})

test('package names with characters Git refs reject are sanitised', () => {
  const report = upgradeReport({
    actions: [{ strategy: 'update-within-declared-range', targetPackage: 'we~ird*pkg', currentVersion: '1.0.0', targetVersion: '1.2.3', outcome: 'applied' }],
  })
  const plan = prPlan({ module: 'web', kind: 'package', reports: [report], singleFinding: true })

  assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', plan.branch], { stdio: 'pipe' }))
})
