import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { plan, runUpgrade, assertResolved } from './helpers/runner.js'
import { checked, command } from './helpers/commands.js'
import { target } from './fixtures/catalog.js'
import { chain, constrained, grandName, hName, parents, pb, pc, reintroduced, sharedGrand, twoAncestorCopies } from './fixtures/parents.js'

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

// The planner's debug log records every sibling CLI it starts, which shows which catalogs it actually asked for.
const planDebug = async (f) => {
  const result = await command(f, 'npm-dep-upgrade-plan', ['.', '--format', 'json', '--debug'])
  assert.equal(result.code, 0, result.stderr)
  return { rows: JSON.parse(result.stdout).rows, catalogs: new Set([...result.stderr.matchAll(/npm-dep-versions[^\n]*?(e2e-[a-z0-9]+)/g)].map(m => m[1])) }
}
const unchanged = async (f) => {
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), f.initialHead)
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'package.json'), 'utf8')), JSON.parse(f.initialFiles['package.json']))
}
const choicesOf = row => row.choices.map(c => `${c.strategy === 'upgrade-via-parent-dependency' ? 'parent' : 'within'}:${c.targetPackage}@${c.targetVersion}`)

for (const npmCli of runtimes) {
  test(`an immediate parent that clears the branch stops the search: no grandparent lookup (${npmCli})`, async (t) => {
    const f = await createProject(chain(), { npmCli }, t)
    const { rows, catalogs } = await planDebug(f)
    const row = finding(rows)
    assert.deepEqual(choicesOf(row), ['within:e2e-target@6.0.12', `parent:${pb}@1.1.0`])
    assert.ok(catalogs.has(pb))
    assert.ok(!catalogs.has(grandName), 'the newer grandparent release was never looked up')
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps: bump ${pb} from 1.0.1 to 1.1.0`])
  })

  test(`a grandparent clears the branch when the immediate parent is pinned by it (${npmCli})`, async (t) => {
    const f = await createProject(chain({ grandPin: true }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.ok(row.choices.some(c => c.strategy === 'upgrade-via-parent-dependency' && c.targetPackage === grandName && c.targetVersion === '1.1.0'))
    assert.ok(!row.choices.some(c => c.targetPackage === pb))
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps: bump ${grandName} from 1.0.0 to 1.1.0`])
    await assertResolved(f, `node_modules/${pb}`, target, '6.0.12')
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'package.json'), 'utf8')), JSON.parse(f.initialFiles['package.json']), 'no override or declaration edit')
  })

  test(`a safe release only three levels up is never searched: no solution within two levels (${npmCli})`, async (t) => {
    const f = await createProject(chain({ grandPin: true, hPin: true, withH: true, pcSpec: '6.0.9' }), { npmCli }, t)
    const { rows, catalogs } = await planDebug(f)
    const row = finding(rows)
    assert.equal(row.resolution, 'none')
    assert.deepEqual(row.choices, [])
    assert.ok(catalogs.has(grandName) && catalogs.has(pb))
    assert.ok(!catalogs.has(hName), 'the third level is never evaluated')
    const result = await runUpgrade(f, [row.id])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /ineligible/i)
    await unchanged(f)
  })

  test(`no safe release anywhere leaves the finding without parent choices (${npmCli})`, async (t) => {
    const s = parents({ pcSpec: '6.0.9' })
    delete s.packages[pb]['1.1.0']
    const f = await createProject(s, { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'none')
    assert.deepEqual(row.choices, [])
  })

  test(`siblings freed by one grandparent become one deduplicated action (${npmCli})`, async (t) => {
    const f = await createProject(sharedGrand(), { npmCli }, t)
    const rows = (await plan(f)).filter(r => r.package === target)
    const row = rows[0]
    const parentChoices = row.choices.filter(c => c.strategy === 'upgrade-via-parent-dependency')
    assert.equal(parentChoices.length, 1)
    assert.equal(parentChoices[0].targetPackage, grandName)
    assert.equal(parentChoices[0].affectedConsumers.length, 2)
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps: bump ${grandName} from 1.0.0 to 1.1.0`])
  })

  test(`a descendant that reintroduces the vulnerable version is not reported as safe (${npmCli})`, async (t) => {
    const f = await createProject(reintroduced(), { npmCli }, t)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), ['within:e2e-target@6.0.12'])
    assert.equal(row.resolution, 'partial')
  })

  test(`a named update that would also move another copy of the ancestor is rejected (${npmCli})`, async (t) => {
    const f = await createProject(twoAncestorCopies(), { npmCli }, t)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), ['within:e2e-target@6.0.12'])
    assert.equal(row.resolution, 'partial')
  })

  test(`an incoming declaration from another consumer excludes the parent release (${npmCli})`, async (t) => {
    const f = await createProject(constrained(), { npmCli }, t)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), ['within:e2e-target@6.0.12'])
    assert.equal(row.resolution, 'partial')
  })
}

const snapshotAt = async (f, hash, name) => {
  const dir = path.join(f.scratch, `snapshot-${name}`)
  await mkdir(dir)
  for (const file of ['package.json', 'package-lock.json']) await writeFile(path.join(dir, file), await checked(f, 'git', ['show', `${hash}:${file}`]) + '\n')
  await writeFile(path.join(dir, '.npmrc'), await readFile(path.join(f.root, '.npmrc')))
  await checked(f, 'npm', ['ci', '--ignore-scripts', '--no-audit'], dir)
  return dir
}

for (const npmCli of runtimes) {
  test(`each commit of a parent-then-child upgrade installs cleanly and resolves as recorded (${npmCli})`, async (t) => {
    const f = await createProject(parents({ pbNext: null }), { npmCli }, t)
    const row = finding(await plan(f))
    const output = JSON.parse((await runUpgrade(f, [row.id, '--format', 'json'])).stdout)
    assert.equal(output.commits.length, 2)
    const first = await snapshotAt(f, output.commits[0].hash, 'parent')
    await assertResolved(f, `node_modules/${pc}`, target, '6.0.9', first)
    assert.deepEqual(JSON.parse(await readFile(path.join(first, 'package.json'), 'utf8')).overrides, undefined)
    const second = await snapshotAt(f, output.commits[1].hash, 'child')
    await assertResolved(f, `node_modules/${pc}`, target, '6.0.12', second)
    assert.deepEqual(JSON.parse(await readFile(path.join(second, 'package.json'), 'utf8')), JSON.parse(f.initialFiles['package.json']))
  })

  test(`a hook rejecting the second commit keeps the first commit and every outside edit (${npmCli})`, async (t) => {
    const f = await createProject(parents({ pbNext: null }), { npmCli }, t)
    const row = finding(await plan(f))
    await writeFile(path.join(f.scratch, 'hooks', 'commit-msg'), `#!/bin/sh\ngrep -q "bump ${target}" "$1" && exit 7\nexit 0\n`, { mode: 0o755 })
    await writeFile(path.join(f.root, 'notes.txt'), 'outside edit\n')
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    const first = (await checked(f, 'git', ['rev-parse', 'HEAD']))
    assert.notEqual(first, f.initialHead)
    assert.equal(await checked(f, 'git', ['rev-list', '--count', `${f.initialHead}..HEAD`]), '1')
    assert.equal(await checked(f, 'git', ['log', '-1', '--format=%s']), `deps: bump ${pb} from 1.0.1 to 1.1.0`)
    assert.match(result.stderr, new RegExp(`completed commits: ${first}`))
    assert.match(result.stderr, /uncommitted|inspect/i)
    assert.equal(await readFile(path.join(f.root, 'notes.txt'), 'utf8'), 'outside edit\n')
  })

  test(`a candidate that became vulnerable after planning is refused before any commit (${npmCli})`, async (t) => {
    const s = parents()
    const original = s.advisories
    s.advisories = phase => (phase === 'stale' ? [...original, { name: pb, range: '1.1.0', id: 10003 }] : original)
    const f = await createProject(s, { npmCli }, t)
    const row = finding(await plan(f))
    f.registry.setPhase('stale')
    const result = await runUpgrade(f, [row.id])
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /vulnerable|stale/i)
    await unchanged(f)
  })

  test(`a parent release that is no longer old enough is refused before any commit (${npmCli})`, async (t) => {
    const s = parents()
    const f = await createProject(s, { npmCli }, t)
    const row = finding(await plan(f))
    s.packages[pb]['1.1.0'].releasedAt = new Date(Date.now() - 86400000).toISOString()
    const result = await runUpgrade(f, [row.id])
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /age|release/i)
    await unchanged(f)
  })
}
