import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { shared, leaf, ago } from './fixtures/catalog.js'
import { plan, runUpgrade, assertResolved } from './helpers/runner.js'
import { checked, command } from './helpers/commands.js'
const runtimes = [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)
for (const npmCli of runtimes) for (const count of [1, 4]) test(`partial: ${count} caret and ${count} pinned consumers (${npmCli})`, async (t) => {
  const scenario = shared(true)
  if (count === 4) for (let i = 2; i <= 4; i++) for (const [prefix, spec] of [['caret', '^6.0.8'], ['pinned', '6.0.9']]) {
    const name = `e2e-${prefix}-${i}`
    scenario.manifest.dependencies[name] = '1.0.0'
    scenario.packages[name] = { '1.0.0': { manifest: leaf(name, '1.0.0', { dependencies: { 'e2e-target': spec } }), releasedAt: ago(20) } }
  }
  const f = await createProject(scenario, { npmCli }, t)
  const rows = await plan(f)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].resolution, 'partial')
  assert.equal(rows[0].choices.length, 1)
  assert.equal(rows[0].choices[0].affectedConsumers.length, count)
  const result = await runUpgrade(f, [rows[0].id, '--format', 'json'])
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.schemaVersion, 3)
  assert.equal(output.resolution, 'partial')
  assert.equal(output.commits.length, 1)
  assert.equal(output.actions[0].targetVersion, '6.0.12')
  assert.deepEqual(await readFile(path.join(f.root, 'package.json')), f.initialFiles['package.json'])
  await assertResolved(f, 'node_modules/e2e-parent-a', 'e2e-target', '6.0.12')
  await assertResolved(f, 'node_modules/e2e-parent-b', 'e2e-target', '6.0.9')
  for (let i = 2; i <= count; i++) {
    await assertResolved(f, `node_modules/e2e-caret-${i}`, 'e2e-target', '6.0.12')
    await assertResolved(f, `node_modules/e2e-pinned-${i}`, 'e2e-target', '6.0.9')
  }
  const remaining = await plan(f)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].resolution, 'none')
  const retry = await runUpgrade(f, [remaining[0].id])
  assert.equal(retry.code, 1)
  assert.match(retry.stderr, /ineligible/i)
  const copy = path.join(f.scratch, 'clean-ci')
  await mkdir(copy)
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) await writeFile(path.join(copy, name), await readFile(path.join(f.root, name)))
  await checked(f, 'npm', ['ci', '--ignore-scripts', '--no-audit'], copy)
  await assertResolved(f, 'node_modules/e2e-parent-a', 'e2e-target', '6.0.12', copy)
  await assertResolved(f, 'node_modules/e2e-parent-b', 'e2e-target', '6.0.9', copy)
})
for (const npmCli of runtimes) test(`two safe ranges create two upgrades and commits (${npmCli})`, async (t) => {
  const scenario = shared()
  scenario.packages['e2e-parent-b']['1.0.0'].manifest.dependencies['e2e-target'] = '6.0.9 || ^7.0.0'
  scenario.packages['e2e-target']['7.0.5'].seed = false
  const f = await createProject(scenario, { npmCli }, t)
  const row = (await plan(f))[0]
  assert.equal(row.resolution, 'complete')
  assert.equal(row.choices.length, 2)
  const result = await runUpgrade(f, [row.id, '--format', 'json'])
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.commits.length, 2)
  assert.deepEqual(output.actions.map(a => a.targetVersion), ['6.0.12', '7.0.5'])
  assert.equal(await checked(f, 'git', ['rev-list', '--count', `${f.initialHead}..HEAD`]), '2')
  await assertResolved(f, 'node_modules/e2e-parent-a', 'e2e-target', '6.0.12')
  await assertResolved(f, 'node_modules/e2e-parent-b', 'e2e-target', '7.0.5')
  assert.equal((await command(f, 'git', ['diff', '--cached', '--name-only'])).stdout, '')
  for (let i = 0; i < output.commits.length; i++) {
    const copy = path.join(f.scratch, `commit-${i}`)
    await mkdir(copy)
    for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(copy, name), await checked(f, 'git', ['show', `${output.commits[i].hash}:${name}`]))
    await writeFile(path.join(copy, '.npmrc'), await readFile(path.join(f.root, '.npmrc')))
    await checked(f, 'npm', ['ci', '--ignore-scripts', '--no-audit'], copy)
    await assertResolved(f, 'node_modules/e2e-parent-a', 'e2e-target', '6.0.12', copy)
    await assertResolved(f, 'node_modules/e2e-parent-b', 'e2e-target', i ? '7.0.5' : '6.0.9', copy)
  }
})
function twoRangeScenario() {
  const scenario = shared()
  scenario.packages['e2e-parent-b']['1.0.0'].manifest.dependencies['e2e-target'] = '6.0.9 || ^7.0.0'
  scenario.packages['e2e-target']['7.0.5'].seed = false
  return scenario
}
test('two-action failure before publication creates no commits', async (t) => {
  const { installCheckpoints } = await import('./helpers/commands.js')
  const { assertUnchanged } = await import('./helpers/runner.js')
  const scenario = twoRangeScenario(), f = await createProject(scenario, {}, t), row = (await plan(f))[0]
  scenario.checkpoint = ({ count, stage }) => count === 2 && stage === 'after' ? { exit: 42 } : {}
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /install/i)
})
test('later commit hook failure preserves the committed prefix', async (t) => {
  const f = await createProject(twoRangeScenario(), {}, t), row = (await plan(f))[0]
  await writeFile(path.join(f.scratch, 'hooks', 'pre-commit'), '#!/bin/sh\ncase "$(git log -1 --format=%s)" in deps:*) exit 42;; esac\n', { mode: 0o755 })
  const result = await runUpgrade(f, [row.id, '--format', 'json'])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  const head = await checked(f, 'git', ['rev-parse', 'HEAD'])
  assert.match(result.stderr, new RegExp(head))
  assert.equal(await checked(f, 'git', ['rev-list', '--count', `${f.initialHead}..HEAD`]), '1')
  assert.equal(await checked(f, 'git', ['diff', '--cached', '--name-only']), '')
  assert.match(await checked(f, 'git', ['diff', '--name-only']), /package-lock.json/)
})
