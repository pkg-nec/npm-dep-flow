import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { plan, runUpgrade, assertResolved } from './helpers/runner.js'
import { checked } from './helpers/commands.js'
import { target } from './fixtures/catalog.js'
import { parents, pb, pc } from './fixtures/parents.js'

const runtimes = [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)
const subjects = async f => (await checked(f, 'git', ['log', '--format=%s', `${f.initialHead}..HEAD`])).split('\n').filter(Boolean).reverse()
const finding = rows => rows.find(row => row.package === target)

for (const npmCli of runtimes) {
  test(`parent pins the safe version and the other consumer is pinned: one parent commit, partial (${npmCli})`, async (t) => {
    const f = await createProject(parents({ pcSpec: '6.0.9' }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'partial')
    assert.deepEqual(row.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`), [`upgrade-via-parent-dependency:${pb}@1.1.0`])
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.resolution, 'partial')
    assert.deepEqual(output.actions.map(a => [a.targetPackage, a.outcome]), [[pb, 'applied']])
    assert.deepEqual(await subjects(f), [`deps: bump ${pb} from 1.0.1 to 1.1.0`])
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'package.json'), 'utf8')), JSON.parse(f.initialFiles['package.json']), 'no override or declaration edit')
    await assertResolved(f, `node_modules/${pb}`, target, '6.0.12')
    await assertResolved(f, `node_modules/${pc}`, target, '6.0.9')
  })
}

for (const npmCli of runtimes) {
  test(`parent pins the safe version and npm dedupes upward: the child action is skipped, one commit, complete (${npmCli})`, async (t) => {
    const f = await createProject(parents(), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.deepEqual(row.choices.map(c => c.strategy), ['update-within-declared-range', 'upgrade-via-parent-dependency'])
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.resolution, 'complete')
    assert.deepEqual(output.actions.map(a => [a.targetPackage, a.outcome]), [[pb, 'applied'], [target, 'already-satisfied']])
    assert.equal(output.commits.length, 1)
    assert.deepEqual(await subjects(f), [`deps: bump ${pb} from 1.0.1 to 1.1.0`])
    await assertResolved(f, `node_modules/${pb}`, target, '6.0.12')
    await assertResolved(f, `node_modules/${pc}`, target, '6.0.12')
    assert.equal((await plan(f)).filter(r => r.package === target).length, 0)
  })

  test(`parent removes the dependency and the residual consumer is upgraded in a second commit (${npmCli})`, async (t) => {
    const f = await createProject(parents({ pbNext: null }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.deepEqual(row.choices.map(c => c.strategy), ['update-within-declared-range', 'upgrade-via-parent-dependency'])
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.deepEqual(output.actions.map(a => [a.targetPackage, a.outcome]), [[pb, 'applied'], [target, 'applied']])
    assert.equal(output.commits.length, 2)
    assert.deepEqual(await subjects(f), [`deps: bump ${pb} from 1.0.1 to 1.1.0`, `deps: bump ${target} from 6.0.9 to 6.0.12`])
    await assertResolved(f, `node_modules/${pc}`, target, '6.0.12')
  })

  test(`parent removes the dependency while the other consumer is pinned: partial with one commit (${npmCli})`, async (t) => {
    const f = await createProject(parents({ pcSpec: '6.0.9', pbNext: null }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'partial')
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).commits.length, 1)
    assert.deepEqual(await subjects(f), [`deps: bump ${pb} from 1.0.1 to 1.1.0`])
    await assertResolved(f, `node_modules/${pc}`, target, '6.0.9')
  })
}
