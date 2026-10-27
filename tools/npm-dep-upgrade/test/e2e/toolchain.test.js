import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { plan, runUpgrade, assertResolved } from './helpers/runner.js'
import { checked } from './helpers/commands.js'
import { ago } from './fixtures/catalog.js'
import { build, cli, core, current, kid, mid, next, other, toolchain } from './fixtures/toolchain.js'

const runtimes = [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)
const subjects = async f => (await checked(f, 'git', ['log', '--format=%s', `${f.initialHead}..HEAD`])).split('\n').filter(Boolean).reverse()
const readJson = async (root, name) => JSON.parse(await readFile(path.join(root, name), 'utf8'))
const finding = rows => rows.find(row => row.package === kid)
const choicesOf = row => row.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`)
const toolchainChoice = `upgrade-angular-toolchain:${cli}@${next}`

// The migrated manifest is the initial one with both members and the devkit override at the new version, nothing else.
async function assertMigrated(f, root = f.root) {
  const expected = JSON.parse(f.initialFiles['package.json'])
  Object.assign(expected.devDependencies, { [cli]: next, [build]: next })
  expected.overrides[core] = next
  assert.deepEqual(await readJson(root, 'package.json'), expected)
  const lock = await readJson(root, 'package-lock.json')
  for (const name of [cli, build, core]) assert.equal(lock.packages[`node_modules/${name}`].version, next, `${name} in the lockfile`)
  assert.deepEqual(lock.packages[''].devDependencies, expected.devDependencies)
  await assertResolved(f, '', cli, next, root)
  await assertResolved(f, `node_modules/${build}`, mid, '1.0.1', root)
}

// Nothing changed: no commit, no staged or unstaged path, no leftover migrations.json, the original dependency bytes.
async function assertNoChange(f, result, pattern) {
  assert.equal(result.code, 1, result.stdout)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, pattern)
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), f.initialHead)
  assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
  for (const [name, bytes] of Object.entries(f.initialFiles)) assert.deepEqual(await readFile(path.join(f.root, name)), bytes, `${name} changed`)
}

// A separate clean `npm ci` of the committed files reproduces the migrated tree.
async function assertReproducible(f) {
  const copy = path.join(f.scratch, 'clean ci')
  await mkdir(copy)
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) await writeFile(path.join(copy, file), await readFile(path.join(f.root, file)))
  await checked(f, 'npm', ['ci', '--ignore-scripts', '--no-audit'], copy)
  await assertMigrated(f, copy)
}

for (const npmCli of runtimes) {
  test(`toolchain: the planner offers the exact-pinned Angular pair as a complete toolchain choice (${npmCli})`, async (t) => {
    const f = await createProject(toolchain(), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.deepEqual(choicesOf(row), [toolchainChoice])
    const [choice] = row.choices
    assert.equal(choice.currentVersion, current)
    assert.equal(choice.targetLocation, `node_modules/${cli}`)
    assert.deepEqual(choice.affectedConsumers, [{ location: `node_modules/${mid}`, requestedName: kid, type: 'dependencies' }])
  })

  test(`toolchain: nx migrate moves both members and the override in one commit (${npmCli})`, async (t) => {
    const f = await createProject(toolchain(), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.resolution, 'complete')
    assert.deepEqual(output.actions.map(a => [a.strategy, a.targetPackage, a.targetVersion, a.outcome]), [['upgrade-angular-toolchain', cli, next, 'applied']])
    assert.deepEqual(await subjects(f), [`deps: migrate Angular toolchain to ${next}`])
    assert.equal(output.commits[0].hash, await checked(f, 'git', ['rev-parse', 'HEAD']))
    assert.deepEqual((await checked(f, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').sort(), ['package-lock.json', 'package.json'])
    assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
    await assertMigrated(f)
    await assertResolved(f, `node_modules/${mid}`, kid, '1.0.1')
    await assertReproducible(f)
    assert.equal(finding(await plan(f)), undefined, 'the finding is gone')
    assert.deepEqual(f.registry.unexpected, [])
  })

  test(`toolchain: --module scopes the migration commit subject (${npmCli})`, async (t) => {
    const f = await createProject(toolchain(), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--module', 'webapp'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps(webapp): migrate Angular toolchain to ${next}`])
    await assertMigrated(f)
  })

  test(`toolchain: a migration that generates migrations.json is reverted without a commit (${npmCli})`, async (t) => {
    const f = await createProject(toolchain({ migrations: true }), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    await assertNoChange(f, result, /generated migrations\.json/)
  })

  test(`toolchain: a target release younger than seven days is refused with no change (${npmCli})`, async (t) => {
    const s = toolchain()
    const f = await createProject(s, { npmCli }, t)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), [toolchainChoice])
    s.packages[cli][next].releasedAt = ago(2)
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    await assertNoChange(f, result, /release age/i)
  })

  test(`toolchain: a finding with toolchain and within-range choices commits the toolchain first (${npmCli})`, async (t) => {
    const f = await createProject(toolchain({ withinRange: true }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.deepEqual(choicesOf(row).sort(), [toolchainChoice, `update-within-declared-range:${kid}@1.0.1`].sort())
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.resolution, 'complete')
    assert.deepEqual(output.actions.map(a => [a.strategy, a.outcome]), [['upgrade-angular-toolchain', 'applied'], ['update-within-declared-range', 'applied']])
    assert.deepEqual(await subjects(f), [`deps: migrate Angular toolchain to ${next}`, `deps: bump ${kid} from 1.0.0 to 1.0.1`])
    assert.deepEqual(output.commits.map(c => c.subject), await subjects(f))
    assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
    await assertMigrated(f)
    await assertResolved(f, `node_modules/${other}`, kid, '1.0.1')
    assert.equal(finding(await plan(f)), undefined, 'the finding is gone')
  })
}
