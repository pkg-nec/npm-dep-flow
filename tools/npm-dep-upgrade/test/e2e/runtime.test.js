import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { plan, runUpgrade, assertResolved } from './helpers/runner.js'
import { checked } from './helpers/commands.js'
import { ago } from './fixtures/catalog.js'
import { RUNTIME, build, cli, compilerCli, core, current, devkit, dynamic, kid, mid, next, runtime, toolMid } from './fixtures/runtime.js'

const runtimes = [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)
const subjects = async f => (await checked(f, 'git', ['log', '--format=%s', `${f.initialHead}..HEAD`])).split('\n').filter(Boolean).reverse()
const readJson = async (root, name) => JSON.parse(await readFile(path.join(root, name), 'utf8'))
const finding = rows => rows.find(row => row.package === kid)
const choicesOf = row => row.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`)
const runtimeChoice = `upgrade-angular-runtime:${core}@${next}`
const toolchainChoice = `upgrade-angular-toolchain:${cli}@${next}`
const TOOLCHAIN = [cli, build]
const versionsIn = (lock, names) => Object.fromEntries(names.map(name => [name, lock.packages[`node_modules/${name}`]?.version]))
const all = (names, version) => Object.fromEntries(names.map(name => [name, version]))

// The initial manifest with the runtime members (each in the field that declares it, exact) and the
// platform-browser-dynamic override at the new version; with `toolchain`, the toolchain pair and its override as well.
function migratedManifest(f, { toolchain = false } = {}) {
  const expected = JSON.parse(f.initialFiles['package.json'])
  for (const name of RUNTIME) {
    const field = name === compilerCli ? 'devDependencies' : 'dependencies'
    assert.ok(Object.hasOwn(expected[field], name), `${name} is declared in ${field}`)
    expected[field][name] = next
  }
  if (Object.hasOwn(expected.overrides, dynamic)) expected.overrides[dynamic] = next
  if (toolchain) {
    Object.assign(expected.devDependencies, { [cli]: next, [build]: next })
    expected.overrides[devkit] = next
  }
  return expected
}

async function assertMigrated(f, { root = f.root, toolchain = false } = {}) {
  const expected = migratedManifest(f, { toolchain })
  assert.deepEqual(await readJson(root, 'package.json'), expected)
  const lock = await readJson(root, 'package-lock.json')
  assert.deepEqual(versionsIn(lock, RUNTIME), all(RUNTIME, next), 'every runtime member is installed at the target')
  assert.deepEqual(versionsIn(lock, [...TOOLCHAIN, devkit]), all([...TOOLCHAIN, devkit], toolchain ? next : current))
  assert.equal(lock.packages[`node_modules/${dynamic}`], undefined, 'the stale override installs nothing')
  assert.deepEqual(lock.packages[''].dependencies, expected.dependencies)
  assert.deepEqual(lock.packages[''].devDependencies, expected.devDependencies)
  await assertResolved(f, '', core, next, root)
  await assertResolved(f, `node_modules/${core}`, mid, '1.0.1', root)
  await assertResolved(f, `node_modules/${mid}`, kid, '1.0.1', root)
}

// Nothing changed: no commit, no staged or unstaged path, no leftover migrations.json, the original dependency bytes.
async function assertNoChange(f, result, pattern) {
  assert.equal(result.code, 1, result.stdout)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, pattern)
  assert.match(result.stderr, /Working tree restored\./)
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), f.initialHead)
  assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
  for (const [name, bytes] of Object.entries(f.initialFiles)) assert.deepEqual(await readFile(path.join(f.root, name)), bytes, `${name} changed`)
}

// A separate clean `npm ci` of the committed files reproduces the migrated tree.
async function assertReproducible(f, options) {
  const copy = path.join(f.scratch, 'clean ci')
  await mkdir(copy)
  for (const file of ['package.json', 'package-lock.json', '.npmrc']) await writeFile(path.join(copy, file), await readFile(path.join(f.root, file)))
  await checked(f, 'npm', ['ci', '--ignore-scripts', '--no-audit'], copy)
  await assertMigrated(f, { ...options, root: copy })
}

// The npm installs the upgrade tool ran, in order, with their outcomes, from its own --debug process log.
function npmInstalls(stderr) {
  const started = new Map(), calls = []
  for (const line of stderr.split('\n')) {
    const start = /\[npm-dep-upgrade debug\] start (\S+) process (\{.*\})$/.exec(line)
    if (start) {
      const { command, args } = JSON.parse(start[2])
      // Windows launches `npm.cmd <args>` as one shell command string; Unix-like systems spawn npm with arguments.
      let words = null
      if (command.startsWith('npm.cmd ')) words = command.split(' ').slice(1)
      else if (command === 'npm') words = args
      if (words && ['ci', 'install'].includes(words[0])) started.set(start[1], words)
      continue
    }
    const end = /\[npm-dep-upgrade debug\] end (\S+) process (\S+)/.exec(line)
    if (end && started.has(end[1])) calls.push({ command: started.get(end[1])[0], forced: started.get(end[1]).includes('-f'), outcome: end[2] })
  }
  return calls
}

// Each line migration: a clean `npm ci`, then a plain install that real npm refuses with ERESOLVE (the exact runtime
// peers against @angular/build's peer set from the lockfile), the forced install, and the plain install that succeeds.
const forcedMigration = [
  { command: 'ci', forced: false, outcome: 'exit=0' },
  { command: 'install', forced: false, outcome: 'exit=1' },
  { command: 'install', forced: true, outcome: 'exit=0' },
  { command: 'install', forced: false, outcome: 'exit=0' },
]

for (const npmCli of runtimes) {
  test(`runtime: the planner offers the exact-pinned Angular runtime as a complete runtime choice (${npmCli})`, async (t) => {
    const f = await createProject(runtime(), { npmCli }, t)
    const lock = await readJson(f.root, 'package-lock.json')
    assert.equal(lock.packages[`node_modules/${dynamic}`], undefined, 'the override is stale: nothing installs it')
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.deepEqual(choicesOf(row), [runtimeChoice])
    const [choice] = row.choices
    assert.equal(choice.currentVersion, current)
    assert.equal(choice.targetLocation, `node_modules/${core}`)
    assert.deepEqual(choice.affectedConsumers, [{ location: `node_modules/${mid}`, requestedName: kid, type: 'dependencies' }])
    assert.match(await plan(f, 'markdown'), new RegExp(`Upgrade Angular runtime: ${core}@${current} → ${core}@${next}`))
  })

  test(`runtime: nx migrate moves the seven members and the override in one commit through the forced install (${npmCli})`, async (t) => {
    const f = await createProject(runtime(), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--format', 'json', '--debug'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.resolution, 'complete')
    assert.deepEqual(output.actions.map(a => [a.strategy, a.targetPackage, a.targetVersion, a.outcome]), [['upgrade-angular-runtime', core, next, 'applied']])
    assert.deepEqual(npmInstalls(result.stderr), forcedMigration)
    assert.match(result.stderr, /ERESOLVE/)
    assert.deepEqual(await subjects(f), [`deps: bump Angular runtime to ${next}`])
    assert.equal(output.commits[0].hash, await checked(f, 'git', ['rev-parse', 'HEAD']))
    assert.deepEqual((await checked(f, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').sort(), ['package-lock.json', 'package.json'])
    assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
    await assertMigrated(f)
    await assertReproducible(f)
    assert.equal(finding(await plan(f)), undefined, 'the finding is gone')
    assert.deepEqual(f.registry.unexpected, [])
  })

  test(`runtime: --module scopes the runtime commit subject (${npmCli})`, async (t) => {
    const f = await createProject(runtime(), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--module', 'webapp'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps(webapp): bump Angular runtime to ${next}`])
    await assertMigrated(f)
  })

  test(`runtime: an nx that also sets the override is accepted (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ nx: { overrides: true } }), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps: bump Angular runtime to ${next}`])
    await assertMigrated(f)
  })

  test(`runtime: without a platform-browser-dynamic override none is added (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ pbdOverride: false }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), [runtimeChoice])
    const result = await runUpgrade(f, [row.id])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(Object.hasOwn((await readJson(f.root, 'package.json')).overrides, dynamic), false)
    await assertMigrated(f)
  })

  test(`runtime: a member declared with ^ is pinned to the target as nx writes it (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ range: '@angular/forms' }), { npmCli }, t)
    assert.equal(JSON.parse(f.initialFiles['package.json']).dependencies['@angular/forms'], `^${current}`)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), [runtimeChoice])
    const result = await runUpgrade(f, [row.id])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await subjects(f), [`deps: bump Angular runtime to ${next}`])
    await assertMigrated(f)
  })

  test(`runtime: an nx that keeps a member's ^ operator is refused and reverted (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ range: '@angular/forms', nx: { keepRange: true } }), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    await assertNoChange(f, result, new RegExp(`@angular/forms in dependencies must be ${next.replaceAll('.', '\\.')}`))
  })

  test(`runtime: a migration that generates migrations.json is reverted without a commit (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ nx: { migrations: true } }), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    await assertNoChange(f, result, /generated migrations\.json/)
  })

  test(`runtime: a target release younger than seven days is refused with no change (${npmCli})`, async (t) => {
    const s = runtime()
    const f = await createProject(s, { npmCli }, t)
    const row = finding(await plan(f))
    assert.deepEqual(choicesOf(row), [runtimeChoice])
    s.packages[core][next].releasedAt = ago(2)
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    assert.equal(result.code, 1, result.stdout)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /runtime release has insufficient release age/)
    assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), f.initialHead)
    assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
    for (const [name, bytes] of Object.entries(f.initialFiles)) assert.deepEqual(await readFile(path.join(f.root, name)), bytes, `${name} changed`)
  })

  test(`runtime: an nx that also moves @angular/cli is refused and reverted (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ nx: { extra: { [cli]: next } } }), { npmCli }, t)
    const row = finding(await plan(f))
    const result = await runUpgrade(f, [row.id, '--format', 'json'])
    await assertNoChange(f, result, /verification: Unexpected change to @angular\/cli in devDependencies/)
  })

  test(`runtime: a finding with toolchain and runtime choices commits the toolchain first (${npmCli})`, async (t) => {
    const f = await createProject(runtime({ both: true }), { npmCli }, t)
    const row = finding(await plan(f))
    assert.equal(row.resolution, 'complete')
    assert.deepEqual(choicesOf(row), [toolchainChoice, runtimeChoice])
    const result = await runUpgrade(f, [row.id, '--format', 'json', '--debug'])
    assert.equal(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.resolution, 'complete')
    assert.deepEqual(output.actions.map(a => [a.strategy, a.targetPackage, a.outcome]), [['upgrade-angular-toolchain', cli, 'applied'], ['upgrade-angular-runtime', core, 'applied']])
    assert.deepEqual(await subjects(f), [`deps: migrate Angular toolchain to ${next}`, `deps: bump Angular runtime to ${next}`])
    assert.deepEqual(output.commits.map(c => c.subject), await subjects(f))
    // The toolchain installs plainly; the runtime needs the forced install.
    assert.deepEqual(npmInstalls(result.stderr), [{ command: 'ci', forced: false, outcome: 'exit=0' }, { command: 'install', forced: false, outcome: 'exit=0' }, ...forcedMigration])
    // The toolchain commit holds only the toolchain move; the runtime is still at the old version there.
    const toolchainCommit = output.commits[0].hash
    const between = JSON.parse(await checked(f, 'git', ['show', `${toolchainCommit}:package.json`]))
    assert.deepEqual([between.devDependencies[cli], between.devDependencies[build], between.overrides[devkit], between.dependencies[core], between.overrides[dynamic]], [next, next, next, current, current])
    assert.equal(await checked(f, 'git', ['status', '--porcelain', '--untracked-files=all']), '')
    await assertMigrated(f, { toolchain: true })
    await assertResolved(f, `node_modules/${build}`, toolMid, '1.0.1')
    await assertReproducible(f, { toolchain: true })
    assert.equal(finding(await plan(f)), undefined, 'the finding is gone')
  })
}
