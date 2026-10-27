import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { gitProject, git } from './helpers/git-project.js'
import { preflightGit } from '../src/git.js'
import { runProcess } from '../src/process.js'
import { TOOLCHAIN_STRATEGY } from '../src/model.js'
import { lineOfStrategy } from '../src/angular-lines.js'
import { migrateLine } from '../src/angular-line-migration.js'

const OLD = '21.2.26', NEW = '21.2.27'
const DAY = 86_400_000
const old = new Date(Date.now() - 30 * DAY).toISOString()
const item = { id: 'x', package: 'vuln-dep', version: '1.0.0', targetLocation: 'node_modules/vuln-dep', resolution: 'complete' }
const choice = { strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: OLD, targetVersion: NEW, affectedConsumers: [{ location: 'node_modules/@angular/cli', requestedName: 'vuln-dep', type: 'dependencies' }] }
const context = { installArgs: ['install', '--ignore-scripts', '--min-release-age=7', '--no-audit', '--no-fund'], minAgeDays: 7, cutoffMs: null }
const options = { module: 'webapp' }

const json = value => JSON.stringify(value, null, 2) + '\n'

function manifestFor(version, { override = true, extra = {} } = {}) {
  return {
    name: 'webapp',
    version: '1.0.0',
    dependencies: { 'left-pad': '1.3.0' },
    devDependencies: { '@angular/build': version, '@angular/cli': version, ...extra },
    overrides: override ? { '@angular-devkit/core': OLD, 'other-pkg': '2.0.0' } : { 'other-pkg': '2.0.0' },
  }
}

function lockFor(manifest, version, vuln) {
  return {
    name: 'webapp',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'webapp', version: '1.0.0', dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
      'node_modules/@angular/build': { version, dev: true },
      'node_modules/@angular/cli': { version, dev: true, dependencies: { 'vuln-dep': vuln } },
      'node_modules/left-pad': { version: '1.3.0' },
      'node_modules/vuln-dep': { version: vuln, dev: true },
    },
  }
}

async function fixture(t, { override = true } = {}) {
  const f = await gitProject(t)
  await writeFile(path.join(f.repo, '.git', 'info', 'exclude'), 'empty-hooks/\n')
  const manifest = manifestFor(OLD, { override })
  await writeFile(path.join(f.root, 'package.json'), json(manifest))
  await writeFile(path.join(f.root, 'package-lock.json'), json(lockFor(manifest, OLD, '1.0.0')))
  await git(f.repo, ['add', '.'])
  await git(f.repo, ['commit', '-m', 'test: angular project'])
  const guard = await preflightGit(f.root)
  return { ...f, guard, project: { root: guard.root }, originalManifest: manifest }
}

// The migrated manifest nx would write: both members move; the devkit override is left for the executor.
function migratedManifest(text, version = NEW) {
  const manifest = JSON.parse(text)
  manifest.devDependencies['@angular/cli'] = version
  manifest.devDependencies['@angular/build'] = version
  return json(manifest)
}

// Unix launches `npm` with an argument list; Windows launches `npm.cmd <args>` as one shell string with no arguments.
// Both are decoded to the same command name and arguments.
function decodeLaunch(command, args) {
  const [name, ...rest] = args.length === 0 && command.includes(' ') ? command.split(' ') : [command, ...args]
  return { command: name.replace(/\.cmd$/, ''), args: rest }
}

// A scripted npm/npx: each behaviour may replace the default effect of a step.
function fakeRun(root, steps = {}) {
  const calls = []
  let installs = 0
  const run = async (launched, launchedArgs, opts) => {
    const { command, args } = decodeLaunch(launched, launchedArgs)
    calls.push({ command, args, cwd: opts.cwd })
    let step = command === 'npx' ? 'migrate' : 'ci'
    if (command === 'npm' && args[0] !== 'ci') step = `install${++installs}`
    if (steps[step]) return steps[step](root)
    if (step === 'migrate') await writeFile(path.join(root, 'package.json'), migratedManifest(await readFile(path.join(root, 'package.json'), 'utf8')))
    if (step.startsWith('install')) {
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      await writeFile(path.join(root, 'package-lock.json'), json(lockFor(manifest, NEW, '1.0.1')))
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const advisoriesFor = (extra = {}) => async packageVersions => new Map([...packageVersions.keys()].map(name => [name, name === 'vuln-dep' ? [{ id: 1, range: '<1.0.1' }] : (extra[name] || [])]))
const catalogFor = (times = {}) => async (root, name) => {
  const versions = name === '@angular/cli' ? [OLD, NEW] : ['1.0.0', '1.0.1', '1.3.0', OLD, NEW]
  return { versions, releaseTimes: new Map(versions.map(v => [v, times[v] || old])), minAgeDays: 7, cutoffMs: null }
}

function adapters(f, overrides = {}) {
  const fake = fakeRun(f.root, overrides.steps)
  const audits = []
  return {
    fake,
    audits,
    value: { run: fake.run, readCatalog: catalogFor(), readCandidateAdvisories: advisoriesFor(), readFreshAudit: async (root) => {
      audits.push(root)
      return overrides.auditRows || []
    }, ...overrides.adapters },
  }
}

async function status(f) {
  return git(f.repo, ['status', '--porcelain', '--untracked-files=all'])
}

async function assertRestored(f, error, pattern) {
  assert.match(error.message, / Working tree restored\.$/)
  if (pattern) assert.match(error.message, pattern)
  assert.equal(await status(f), '')
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), f.guard.head)
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), json(f.originalManifest))
}

const line = lineOfStrategy(TOOLCHAIN_STRATEGY)
const migrate = (f, a) => migrateLine({ line, guard: f.guard, project: f.project, item, choice, context, options, adapters: a.value })

async function rejectsRestored(f, a, predicate) {
  let failure
  try {
    await migrate(f, a)
  }
  catch (error) { failure = error }
  assert.ok(failure, 'migration should fail')
  assert.ok(predicate(failure), failure.message)
  await assertRestored(f, failure)
}

test('happy path commits exactly the migrated dependency files', async (t) => {
  const f = await fixture(t), a = adapters(f), start = f.guard.head
  const result = await migrate(f, a)
  assert.equal((await git(f.repo, ['log', '-1', '--format=%s'])).trim(), `deps(webapp): migrate Angular toolchain to ${NEW}`)
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD^'])).trim(), start)
  assert.deepEqual((await git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim().split('\n').sort(), ['package-lock.json', 'package.json'])
  assert.equal(await status(f), '')
  const committed = JSON.parse(await git(f.repo, ['show', 'HEAD:package.json']))
  assert.equal(committed.devDependencies['@angular/cli'], NEW)
  assert.equal(committed.overrides['@angular-devkit/core'], NEW)
  assert.equal(committed.overrides['other-pkg'], '2.0.0')
  assert.deepEqual(a.fake.calls.map(c => [c.command, ...c.args]), [
    ['npm', 'ci', ...context.installArgs.slice(1)],
    ['npx', '--no', 'nx', 'migrate', `@angular/cli@${NEW}`],
    ['npm', ...context.installArgs],
  ])
  assert.ok(a.fake.calls.every(c => c.cwd === f.guard.root))
  assert.equal(a.audits.length, 1)
  assert.equal(result.commit.hash, f.guard.head)
  assert.equal(result.commit.subject, `deps(webapp): migrate Angular toolchain to ${NEW}`)
  assert.deepEqual(result.action, { ...choice, targetVersion: NEW, outcome: 'applied', targetLocations: [choice.targetLocation], releasedAt: old, supportingChanges: [] })
  // The guard follows the commit so later phases start from it.
  assert.deepEqual(f.guard.originalFiles['package.json'], await readFile(path.join(f.root, 'package.json')))
  assert.deepEqual(f.guard.ownedFiles['package-lock.json'], await readFile(path.join(f.root, 'package-lock.json')))
})

for (const platform of ['win32', 'linux']) {
  test(`happy path runs the whole flow with ${platform} launches`, async (t) => {
    const f = await fixture(t), a = adapters(f, { adapters: { platform } })
    await migrate(f, a)
    assert.equal((await git(f.repo, ['log', '-1', '--format=%s'])).trim(), `deps(webapp): migrate Angular toolchain to ${NEW}`)
    assert.equal(await status(f), '')
    assert.deepEqual(a.fake.calls.map(c => [c.command, ...c.args]), [
      ['npm', 'ci', ...context.installArgs.slice(1)],
      ['npx', '--no', 'nx', 'migrate', `@angular/cli@${NEW}`],
      ['npm', ...context.installArgs],
    ])
  })
}

test('override absent leaves overrides untouched', async (t) => {
  const f = await fixture(t, { override: false }), a = adapters(f)
  await migrate(f, a)
  const committed = JSON.parse(await git(f.repo, ['show', 'HEAD:package.json']))
  assert.deepEqual(committed.overrides, { 'other-pkg': '2.0.0' })
})

for (const variant of ['staged', 'unstaged', 'untracked']) test(`dirty tree (${variant}) fails before running anything`, async (t) => {
  const f = await fixture(t), a = adapters(f)
  let catalogReads = 0
  a.value.readCatalog = async () => {
    catalogReads++
    return catalogFor()()
  }
  if (variant === 'untracked') await writeFile(path.join(f.repo, 'notes.txt'), 'user\n')
  else await writeFile(path.join(f.repo, 'unrelated.txt'), 'user edit\n')
  if (variant === 'staged') await git(f.repo, ['add', 'unrelated.txt'])
  const before = await status(f)
  await assert.rejects(migrate(f, a), error => error.code === 'GIT_PRECONDITION' && !/restored/.test(error.message))
  assert.equal(a.fake.calls.length, 0)
  assert.equal(catalogReads, 0)
  assert.equal(await status(f), before)
})

test('release too young runs no subprocess', async (t) => {
  const f = await fixture(t), a = adapters(f, { adapters: { readCatalog: catalogFor({ [NEW]: new Date(Date.now() - DAY).toISOString() }) } })
  await assert.rejects(migrate(f, a), error => error.code === 'RELEASE_AGE')
  assert.equal(a.fake.calls.length, 0)
  assert.equal(await status(f), '')
})

test('lockfile out of sync after npm ci fails and is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { ci: async (root) => {
    await writeFile(path.join(root, 'package-lock.json'), '{}\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'LOCK_OUT_OF_SYNC')
  assert.equal(a.fake.calls.length, 1)
})

test('npm ci failure is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { ci: async () => ({ code: 1, stdout: '', stderr: 'boom' }) } })
  await rejectsRestored(f, a, error => error.code === 'INSTALL_FAILED')
})

test('migrations.json aborts with MIGRATIONS_GENERATED and is removed', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { migrate: async (root) => {
    await writeFile(path.join(root, 'package.json'), migratedManifest(await readFile(path.join(root, 'package.json'), 'utf8')))
    await writeFile(path.join(root, 'migrations.json'), '{"migrations":[]}\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'MIGRATIONS_GENERATED')
  await assert.rejects(access(path.join(f.root, 'migrations.json')))
})

test('ignored migrations.json is removed too', async (t) => {
  const f = await fixture(t)
  await writeFile(path.join(f.repo, '.git', 'info', 'exclude'), 'empty-hooks/\nmigrations.json\n')
  const a = adapters(f, { steps: { migrate: async (root) => {
    await writeFile(path.join(root, 'migrations.json'), '{}\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'MIGRATIONS_GENERATED')
  await assert.rejects(access(path.join(f.root, 'migrations.json')))
})

test('nx migrate failure is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { migrate: async (root) => {
    await writeFile(path.join(root, 'package.json'), '{}\n')
    return { code: 1, stdout: '', stderr: 'nx failed' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'MIGRATION_FAILED')
})

const writeInstalledLock = async (root) => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  await writeFile(path.join(root, 'package-lock.json'), json(lockFor(manifest, NEW, '1.0.1')))
  return { code: 0, stdout: '', stderr: '' }
}
const failed = async () => ({ code: 1, stdout: '', stderr: 'ERESOLVE' })

// Only the dependency files and migrations.json belong to the run; anything else is left in place and named.
async function rejectsLeaving(f, a, predicate, paths) {
  let failure
  try {
    await migrate(f, a)
  }
  catch (error) { failure = error }
  assert.ok(failure, 'migration should fail')
  assert.ok(predicate(failure), failure.message)
  assert.match(failure.message, /Working tree could not be fully restored: left in place for you to inspect: /)
  for (const file of paths) assert.ok(failure.message.includes(file), `${file} is named`)
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), f.guard.head)
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), json(f.originalManifest))
  assert.deepEqual(await readFile(path.join(f.root, 'package-lock.json')), f.guard.originalFiles['package-lock.json'])
  assert.deepEqual((await status(f)).split('\n').filter(Boolean).map(entry => entry.slice(3)).sort(), [...paths].sort())
  return failure
}

test('files outside package.json changed by nx are left in place and named', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { migrate: async (root) => {
    await writeFile(path.join(root, 'package.json'), migratedManifest(await readFile(path.join(root, 'package.json'), 'utf8')))
    await writeFile(path.join(root, 'unrelated.txt'), 'edited by nx\n')
    await writeFile(path.join(root, 'angular.json'), '{}\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsLeaving(f, a, error => error.code === 'UNEXPECTED_FILE_CHANGE', ['unrelated.txt', 'angular.json'])
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'edited by nx\n')
  assert.equal(await readFile(path.join(f.root, 'angular.json'), 'utf8'), '{}\n')
})

test('concurrent user work survives a failed run byte for byte', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: async (root) => {
    await writeFile(path.join(root, 'unrelated.txt'), 'user edit in the IDE\n')
    await writeFile(path.join(root, 'new-user-file.txt'), 'draft\n')
    return { code: 1, stdout: '', stderr: 'ERESOLVE' }
  }, install2: failed } })
  await rejectsLeaving(f, a, error => error.code === 'INSTALL_FAILED', ['unrelated.txt', 'new-user-file.txt'])
  assert.equal(await readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'user edit in the IDE\n')
  assert.equal(await readFile(path.join(f.root, 'new-user-file.txt'), 'utf8'), 'draft\n')
})

test('a dependency file changed outside the run is left and reported', async (t) => {
  const f = await fixture(t)
  const foreign = '{"edited":"by someone else"}\n'
  const a = adapters(f, { adapters: { verifyFreshAudit: async ({ root }) => {
    await writeFile(path.join(root, 'package.json'), foreign)
    throw Object.assign(new Error('audit failed'), { code: 'AUDIT_FAILED', stage: 'audit' })
  } } })
  let failure
  try {
    await migrate(f, a)
  }
  catch (error) { failure = error }
  assert.equal(failure?.code, 'AUDIT_FAILED')
  assert.match(failure.message, /^audit failed\. Working tree could not be fully restored: left in place for you to inspect: package\.json \(changed outside this run\); inspect Git state\.$/)
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), foreign)
  assert.deepEqual(await readFile(path.join(f.root, 'package-lock.json')), f.guard.originalFiles['package-lock.json'])
  assert.equal(await status(f), ' M package.json\n')
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), f.guard.head)
})

test('recovery suffix is separated from the original message', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { ci: async () => ({ code: 1, stdout: '', stderr: 'boom' }) } })
  await rejectsRestored(f, a, error => error.message === 'npm ci failed; inspect npm diagnostics. Working tree restored.')
})

test('nx migrate runs with lifecycle scripts disabled and the caller environment kept', async (t) => {
  const f = await fixture(t), a = adapters(f), envs = []
  const inner = a.value.run
  a.value.run = async (command, args, opts) => {
    envs.push(opts.env)
    return inner(command, args, opts)
  }
  await migrate(f, a)
  assert.equal(envs[1].npm_config_ignore_scripts, 'true')
  assert.equal(envs[1].PATH, process.env.PATH)
})

for (const [label, edit] of [
  ['off-allowlist edit', manifest => ({ ...manifest, dependencies: { 'left-pad': '1.3.1' } })],
  ['wrong-version edit', manifest => ({ ...manifest, devDependencies: { ...manifest.devDependencies, '@angular/build': '21.2.28' } })],
  ['missing @angular/cli bump', manifest => ({ ...manifest, devDependencies: { ...manifest.devDependencies, '@angular/cli': OLD } })],
  ['missing @angular/build bump', manifest => ({ ...manifest, devDependencies: { ...manifest.devDependencies, '@angular/build': OLD } })],
]) test(`${label} fails with UNEXPECTED_MANIFEST_CHANGE and is reverted`, async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { migrate: async (root) => {
    const migrated = JSON.parse(migratedManifest(await readFile(path.join(root, 'package.json'), 'utf8')))
    await writeFile(path.join(root, 'package.json'), json(edit(migrated)))
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'UNEXPECTED_MANIFEST_CHANGE')
  assert.equal(a.fake.calls.length, 2)
})

test('plain install failure retries with -f and then plain install must pass', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: failed, install2: writeInstalledLock, install3: writeInstalledLock } })
  await migrate(f, a)
  assert.deepEqual(a.fake.calls.slice(2).map(c => c.args), [context.installArgs, [...context.installArgs, '-f'], context.installArgs])
  assert.equal(await status(f), '')
})

test('a declared member the install left at another version is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: async (root) => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const lock = lockFor(manifest, NEW, '1.0.1')
    lock.packages['node_modules/@angular/build'].version = OLD
    await writeFile(path.join(root, 'package-lock.json'), json(lock))
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'TARGET_MISMATCH' && error.message.startsWith(`@angular/build did not install at ${NEW}.`))
})

test('install failing with -f too is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: failed, install2: failed } })
  await rejectsRestored(f, a, error => error.code === 'INSTALL_FAILED')
  assert.equal(a.fake.calls.length, 4)
})

test('plain install failing after the -f retry is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: failed, install2: writeInstalledLock, install3: failed } })
  await rejectsRestored(f, a, error => error.code === 'INSTALL_FAILED')
  assert.equal(a.fake.calls.length, 5)
})

test('install that creates files beyond the dependency files leaves them in place and named', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: async (root) => {
    await writeInstalledLock(root)
    await writeFile(path.join(root, '.npmrc-generated'), 'x\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsLeaving(f, a, error => error.code === 'UNEXPECTED_FILE_CHANGE', ['.npmrc-generated'])
  assert.equal(await readFile(path.join(f.root, '.npmrc-generated'), 'utf8'), 'x\n')
})

test('finding consumers still affected after the migration is reverted', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { install1: async (root) => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    await writeFile(path.join(root, 'package-lock.json'), json(lockFor(manifest, NEW, '1.0.0')))
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await rejectsRestored(f, a, error => error.code === 'TOOLCHAIN_NOT_CLEARED')
})

test('a new advisory on a changed version is reverted', async (t) => {
  const f = await fixture(t), a = adapters(f, { adapters: { readCandidateAdvisories: advisoriesFor({ '@angular/build': [{ id: 9, range: `>=${NEW}` }] }) } })
  await rejectsRestored(f, a, error => error.code === 'VULNERABLE_SUPPORTING_CHANGE')
})

test('a fresh audit row for a changed version is reverted', async (t) => {
  const f = await fixture(t), a = adapters(f, { auditRows: [{ package: '@angular/build', version: NEW, advisories: [{ id: 7, range: '*' }] }] })
  await rejectsRestored(f, a, error => /Fresh audit/.test(error.message))
})

test('rejected commit hook is reverted with HEAD unchanged', async (t) => {
  const f = await fixture(t), a = adapters(f)
  await writeFile(path.join(f.repo, 'empty-hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await rejectsRestored(f, a, error => /commit failed/.test(error.message))
})

test('revert refuses to touch the tree when HEAD moved and says so', async (t) => {
  const f = await fixture(t)
  const a = adapters(f, { steps: { migrate: async (root) => {
    await writeFile(path.join(root, 'unrelated.txt'), 'concurrent\n')
    await git(root, ['commit', '-qam', 'test: concurrent work'])
    await writeFile(path.join(root, 'package.json'), migratedManifest(await readFile(path.join(root, 'package.json'), 'utf8')))
    return { code: 0, stdout: '', stderr: '' }
  } } })
  const concurrent = async () => (await git(f.repo, ['rev-parse', 'HEAD'])).trim()
  await assert.rejects(migrate(f, a), error => /Working tree could not be fully restored: .*HEAD changed/.test(error.message) && !/Working tree restored/.test(error.message))
  assert.notEqual(await concurrent(), f.guard.head)
  assert.equal((await git(f.repo, ['log', '-1', '--format=%s'])).trim(), 'test: concurrent work')
  assert.match(await status(f), /package\.json/)
})

test('Windows launches npm.cmd and npx.cmd through a shell', async (t) => {
  const f = await fixture(t), spawned = []
  const scripted = fakeRun(f.root)
  const spawnImpl = (command, args, opts) => {
    spawned.push({ command, args, shell: opts.shell })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    const [name, ...rest] = command.split(' ')
    scripted.run(name.replace(/\.cmd$/, ''), rest, { cwd: opts.cwd }).then((r) => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', r.code, null)
    })
    return child
  }
  const a = adapters(f, { adapters: { platform: 'win32', run: (command, args, opts) => runProcess(command, args, { ...opts, spawnImpl }) } })
  await migrate(f, a)
  assert.deepEqual(spawned.map(s => s.command.split(' ')[0]), ['npm.cmd', 'npx.cmd', 'npm.cmd'])
  assert.equal(spawned[1].command, `npx.cmd --no nx migrate @angular/cli@${NEW}`)
  assert.ok(spawned.every(s => s.shell === true && s.args.length === 0))
})

test('Unix launches npm and npx directly', async (t) => {
  const f = await fixture(t), spawned = []
  const scripted = fakeRun(f.root)
  const spawnImpl = (command, args, opts) => {
    spawned.push({ command, args, shell: opts.shell })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    scripted.run(command, args, { cwd: opts.cwd }).then((r) => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', r.code, null)
    })
    return child
  }
  const a = adapters(f, { adapters: { platform: 'linux', run: (command, args, opts) => runProcess(command, args, { ...opts, spawnImpl }) } })
  await migrate(f, a)
  assert.deepEqual(spawned.map(s => s.command), ['npm', 'npx', 'npm'])
  assert.deepEqual(spawned[1].args, ['--no', 'nx', 'migrate', `@angular/cli@${NEW}`])
  assert.ok(spawned.every(s => s.shell === false))
})

test('the line drives the commit description, strategy and messages', async (t) => {
  const renamed = { ...line, name: 'renamed', strategy: 'upgrade-angular-renamed', description: version => `migrate renamed line to ${version}` }
  const f = await fixture(t), a = adapters(f)
  let committed
  a.value.commitUpgrade = async (...args) => {
    committed = args[2]
    const { commitUpgrade } = await import('../src/git.js')
    return commitUpgrade(...args)
  }
  const result = await migrateLine({ line: renamed, guard: f.guard, project: f.project, item, choice, context, options, adapters: a.value })
  assert.equal(result.commit.subject, `deps(webapp): migrate renamed line to ${NEW}`)
  assert.deepEqual(committed, { package: '@angular/cli', oldVersion: OLD, newVersion: NEW, strategy: 'upgrade-angular-renamed', description: `migrate renamed line to ${NEW}` })
  assert.deepEqual(a.fake.calls[1].args, ['--no', 'nx', 'migrate', `@angular/cli@${NEW}`])
  await writeFile(path.join(f.root, 'scratch.txt'), 'x\n')
  await assert.rejects(migrateLine({ line: renamed, guard: f.guard, project: f.project, item, choice, context, options, adapters: adapters(f).value }), /Angular renamed migration requires a clean working tree/)
})

// ---- Runtime line -------------------------------------------------------------------------------------------------
// The webapp shape: six runtime members in dependencies, @angular/compiler-cli beside the toolchain in devDependencies,
// and a stale @angular/platform-browser-dynamic override (no lockfile entry, no dependent).
const RT_OLD = '21.2.10', RT_NEW = '21.2.11'
const RUNTIME_STRATEGY = 'upgrade-angular-runtime'
const runtimeLine = lineOfStrategy(RUNTIME_STRATEGY)
const RUNTIME_DEPS = ['@angular/common', '@angular/compiler', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router']
const runtimeChoice = { strategy: RUNTIME_STRATEGY, targetPackage: '@angular/core', targetLocation: 'node_modules/@angular/core', currentVersion: RT_OLD, targetVersion: RT_NEW, affectedConsumers: [{ location: 'node_modules/@angular/core', requestedName: 'vuln-dep', type: 'dependencies' }] }

function webappManifest({ override = true } = {}) {
  return {
    name: 'webapp',
    version: '1.0.0',
    dependencies: { ...Object.fromEntries(RUNTIME_DEPS.map(name => [name, RT_OLD])), 'left-pad': '1.3.0' },
    devDependencies: { '@angular/build': OLD, '@angular/cli': OLD, '@angular/compiler-cli': RT_OLD },
    overrides: { '@angular-devkit/core': OLD, ...(override ? { '@angular/platform-browser-dynamic': '20.3.0' } : {}), 'other-pkg': '2.0.0' },
  }
}

const runtimeVersion = manifest => manifest.dependencies['@angular/core']

// The lockfile npm would write for a manifest: every member at its declared version; @angular/cli and @angular/core
// each need vuln-dep 1.0.0 until their next release needs 1.0.1, so a split nests the fixed copy under the toolchain.
function webappLock(manifest, { stuck = {} } = {}) {
  const cli = manifest.devDependencies['@angular/cli'], core = runtimeVersion(manifest)
  const cliNeeds = cli === NEW ? '1.0.1' : '1.0.0', coreNeeds = core === RT_NEW ? '1.0.1' : '1.0.0'
  const packages = { '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, devDependencies: manifest.devDependencies } }
  for (const field of ['dependencies', 'devDependencies']) for (const [name, version] of Object.entries(manifest[field])) {
    packages[`node_modules/${name}`] = { version: stuck[name] || version, ...(field === 'devDependencies' ? { dev: true } : {}) }
  }
  packages['node_modules/@angular/cli'].dependencies = { 'vuln-dep': cliNeeds }
  packages['node_modules/@angular/core'].dependencies = { 'vuln-dep': coreNeeds }
  packages['node_modules/vuln-dep'] = { version: coreNeeds }
  if (cliNeeds !== coreNeeds) packages['node_modules/@angular/cli/node_modules/vuln-dep'] = { version: cliNeeds, dev: true }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }
}

async function webappFixture(t, options) {
  const f = await gitProject(t)
  await writeFile(path.join(f.repo, '.git', 'info', 'exclude'), 'empty-hooks/\n')
  const manifest = webappManifest(options)
  await writeFile(path.join(f.root, 'package.json'), json(manifest))
  await writeFile(path.join(f.root, 'package-lock.json'), json(webappLock(manifest)))
  await git(f.repo, ['add', '.'])
  await git(f.repo, ['commit', '-m', 'test: angular webapp'])
  const guard = await preflightGit(f.root)
  return { ...f, guard, project: { root: guard.root }, originalManifest: manifest }
}

// What nx migrate <anchor>@<version> writes: the members the root declares move to the version, nothing else.
async function nxMigrate(root, args) {
  const spec = args.at(-1), at = spec.lastIndexOf('@'), anchor = spec.slice(0, at), version = spec.slice(at + 1)
  const line = [lineOfStrategy(TOOLCHAIN_STRATEGY), runtimeLine].find(entry => entry.anchor === anchor)
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'devDependencies']) for (const name of line.members) if (manifest[field]?.[name]) manifest[field][name] = version
  await writeFile(path.join(root, 'package.json'), json(manifest))
}

// A scripted npm/npx for the webapp. Like real npm after nx migrate, a plain install fails with ERESOLVE while the
// lockfile's runtime members disagree with the manifest (they peer exactly on each other); `-f` writes the lockfile,
// and the plain install after it then succeeds without changing it.
function webappRun(root, steps = {}) {
  const calls = []
  let installs = 0
  const run = async (launched, launchedArgs, opts) => {
    const { command, args } = decodeLaunch(launched, launchedArgs)
    calls.push({ command, args, cwd: opts.cwd })
    let step = command === 'npx' ? 'migrate' : 'ci'
    if (command === 'npm' && args[0] !== 'ci') step = `install${++installs}`
    if (steps[step]) return steps[step](root, args)
    if (step === 'migrate') await nxMigrate(root, args)
    if (step.startsWith('install')) {
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
      const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
      if (!args.includes('-f') && lock.packages['node_modules/@angular/core'].version !== runtimeVersion(manifest)) return { code: 1, stdout: '', stderr: 'npm error code ERESOLVE' }
      await writeFile(path.join(root, 'package-lock.json'), json(webappLock(manifest)))
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const webappCatalog = (times = {}, reads = []) => async (root, name) => {
  reads.push(name)
  const anchors = { '@angular/cli': [OLD, NEW], '@angular/core': [RT_OLD, RT_NEW] }
  const versions = anchors[name] || ['1.0.0', '1.0.1', '1.3.0', OLD, NEW, RT_OLD, RT_NEW]
  return { versions, releaseTimes: new Map(versions.map(v => [v, times[v] || old])), minAgeDays: 7, cutoffMs: null }
}

function webappAdapters(f, overrides = {}) {
  const fake = webappRun(f.root, overrides.steps)
  const catalogReads = []
  return {
    fake,
    catalogReads,
    value: { run: fake.run, readCatalog: webappCatalog({}, catalogReads), readCandidateAdvisories: advisoriesFor(), readFreshAudit: async () => [], ...overrides.adapters },
  }
}

const migrateRuntime = (f, a) => migrateLine({ line: runtimeLine, guard: f.guard, project: f.project, item, choice: runtimeChoice, context, options, adapters: a.value })
const runtimeInstalls = [context.installArgs, [...context.installArgs, '-f'], context.installArgs]

async function runtimeRejectsRestored(f, a, predicate) {
  let failure
  try {
    await migrateRuntime(f, a)
  }
  catch (error) { failure = error }
  assert.ok(failure, 'migration should fail')
  assert.ok(predicate(failure), failure.message)
  await assertRestored(f, failure)
  return failure
}

for (const platform of ['win32', 'linux']) {
  test(`runtime: the happy path bumps the seven members and the override in one commit with ${platform} launches`, async (t) => {
    const f = await webappFixture(t), a = webappAdapters(f, { adapters: { platform } }), start = f.guard.head
    const result = await migrateRuntime(f, a)
    assert.equal((await git(f.repo, ['log', '-1', '--format=%s'])).trim(), `deps(webapp): bump Angular runtime to ${RT_NEW}`)
    assert.equal((await git(f.repo, ['rev-parse', 'HEAD^'])).trim(), start)
    assert.deepEqual((await git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim().split('\n').sort(), ['package-lock.json', 'package.json'])
    assert.equal(await status(f), '')
    assert.deepEqual(a.fake.calls.map(c => [c.command, ...c.args]), [
      ['npm', 'ci', ...context.installArgs.slice(1)],
      ['npx', '--no', 'nx', 'migrate', `@angular/core@${RT_NEW}`],
      ...runtimeInstalls.map(args => ['npm', ...args]),
    ])
    assert.ok(a.fake.calls.every(c => c.cwd === f.guard.root))
    assert.equal(a.catalogReads[0], '@angular/core')
    const committed = JSON.parse(await git(f.repo, ['show', 'HEAD:package.json']))
    for (const name of RUNTIME_DEPS) assert.equal(committed.dependencies[name], RT_NEW)
    assert.equal(committed.devDependencies['@angular/compiler-cli'], RT_NEW)
    assert.deepEqual([committed.devDependencies['@angular/cli'], committed.devDependencies['@angular/build']], [OLD, OLD])
    assert.deepEqual(committed.overrides, { '@angular-devkit/core': OLD, '@angular/platform-browser-dynamic': RT_NEW, 'other-pkg': '2.0.0' })
    const lock = JSON.parse(await git(f.repo, ['show', 'HEAD:package-lock.json']))
    assert.equal(lock.packages['node_modules/vuln-dep'].version, '1.0.1')
    assert.equal(lock.packages['node_modules/@angular/platform-browser-dynamic'], undefined)
    assert.equal(result.commit.subject, `deps(webapp): bump Angular runtime to ${RT_NEW}`)
    assert.deepEqual(result.action, { ...runtimeChoice, targetVersion: RT_NEW, outcome: 'applied', targetLocations: ['node_modules/@angular/core'], releasedAt: old, supportingChanges: [] })
  })
}

test('runtime: an absent platform-browser-dynamic override stays absent', async (t) => {
  const f = await webappFixture(t, { override: false }), a = webappAdapters(f)
  await migrateRuntime(f, a)
  assert.deepEqual(JSON.parse(await git(f.repo, ['show', 'HEAD:package.json'])).overrides, { '@angular-devkit/core': OLD, 'other-pkg': '2.0.0' })
})

test('runtime: release age is read from @angular/core and a young release runs no subprocess', async (t) => {
  const f = await webappFixture(t), a = webappAdapters(f)
  a.value.readCatalog = webappCatalog({ [RT_NEW]: new Date(Date.now() - DAY).toISOString(), [NEW]: new Date(Date.now() - DAY).toISOString() }, a.catalogReads)
  await assert.rejects(migrateRuntime(f, a), error => error.code === 'RELEASE_AGE' && /runtime/.test(error.message))
  assert.deepEqual(a.catalogReads, ['@angular/core'])
  assert.equal(a.fake.calls.length, 0)
  assert.equal(await status(f), '')
})

test('runtime: migrations.json aborts with MIGRATIONS_GENERATED and is reverted', async (t) => {
  const f = await webappFixture(t)
  const a = webappAdapters(f, { steps: { migrate: async (root, args) => {
    await nxMigrate(root, args)
    await writeFile(path.join(root, 'migrations.json'), '{"migrations":[]}\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await runtimeRejectsRestored(f, a, error => error.code === 'MIGRATIONS_GENERATED')
  await assert.rejects(access(path.join(f.root, 'migrations.json')))
  assert.equal(a.fake.calls.length, 2)
})

for (const [label, edit] of [
  ['an nx run that also bumps @angular/cli', manifest => Object.assign(manifest.devDependencies, { '@angular/cli': RT_NEW })],
  ['an nx run that also bumps @angular/build', manifest => Object.assign(manifest.devDependencies, { '@angular/build': RT_NEW })],
  ['an nx run that adds an eighth package', manifest => Object.assign(manifest.dependencies, { '@angular/animations': RT_NEW })],
  ['an nx run that leaves a member behind', manifest => Object.assign(manifest.dependencies, { '@angular/forms': RT_OLD })],
  ['an nx run that moves a member to another version', manifest => Object.assign(manifest.devDependencies, { '@angular/compiler-cli': '21.2.12' })],
  ['an nx run that sets the override to another version', manifest => Object.assign(manifest.overrides, { '@angular/platform-browser-dynamic': '21.2.27' })],
]) test(`runtime: ${label} fails with UNEXPECTED_MANIFEST_CHANGE and is reverted`, async (t) => {
  const f = await webappFixture(t)
  const a = webappAdapters(f, { steps: { migrate: async (root, args) => {
    await nxMigrate(root, args)
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    edit(manifest)
    await writeFile(path.join(root, 'package.json'), json(manifest))
    return { code: 0, stdout: '', stderr: '' }
  } } })
  await runtimeRejectsRestored(f, a, error => error.code === 'UNEXPECTED_MANIFEST_CHANGE')
  assert.equal(a.fake.calls.length, 2)
})

test('runtime: an install failing even with -f is reverted', async (t) => {
  const f = await webappFixture(t)
  const a = webappAdapters(f, { steps: { install2: failed } })
  await runtimeRejectsRestored(f, a, error => error.code === 'INSTALL_FAILED' && /even with -f/.test(error.message))
  assert.deepEqual(a.fake.calls.slice(2).map(c => c.args), runtimeInstalls.slice(0, 2))
})

test('runtime: a member the forced install left at another version is reverted', async (t) => {
  const f = await webappFixture(t)
  const forced = async (root) => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    await writeFile(path.join(root, 'package-lock.json'), json(webappLock(manifest, { stuck: { '@angular/forms': RT_OLD } })))
    return { code: 0, stdout: '', stderr: '' }
  }
  const a = webappAdapters(f, { steps: { install2: forced, install3: async () => ({ code: 0, stdout: '', stderr: '' }) } })
  await runtimeRejectsRestored(f, a, error => error.code === 'TARGET_MISMATCH' && /@angular\/forms did not install at 21\.2\.11/.test(error.message))
})

test('runtime: a finding consumer still affected after the forced install is reverted', async (t) => {
  const f = await webappFixture(t)
  const forced = async (root) => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const lock = webappLock(manifest)
    lock.packages['node_modules/@angular/core'].dependencies = { 'vuln-dep': '1.0.0' }
    lock.packages['node_modules/vuln-dep'].version = '1.0.0'
    delete lock.packages['node_modules/@angular/cli/node_modules/vuln-dep']
    await writeFile(path.join(root, 'package-lock.json'), json(lock))
    return { code: 0, stdout: '', stderr: '' }
  }
  const a = webappAdapters(f, { steps: { install2: forced, install3: async () => ({ code: 0, stdout: '', stderr: '' }) } })
  await runtimeRejectsRestored(f, a, error => error.code === 'RUNTIME_NOT_CLEARED')
})

test('runtime: a new advisory on a runtime member the install changed is reverted', async (t) => {
  const f = await webappFixture(t), a = webappAdapters(f, { adapters: { readCandidateAdvisories: advisoriesFor({ '@angular/forms': [{ id: 9, range: `>=${RT_NEW}` }] }) } })
  await runtimeRejectsRestored(f, a, error => error.code === 'VULNERABLE_SUPPORTING_CHANGE')
})

test('runtime: the Windows launch form reaches npx.cmd through a shell', async (t) => {
  const f = await webappFixture(t), spawned = []
  const scripted = webappRun(f.root)
  const spawnImpl = (command, args, opts) => {
    spawned.push({ command, args, shell: opts.shell })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    scripted.run(command, args, { cwd: opts.cwd }).then((r) => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', r.code, null)
    })
    return child
  }
  const a = webappAdapters(f, { adapters: { platform: 'win32', run: (command, args, opts) => runProcess(command, args, { ...opts, spawnImpl }) } })
  await migrateRuntime(f, a)
  assert.equal(spawned[1].command, `npx.cmd --no nx migrate @angular/core@${RT_NEW}`)
  assert.deepEqual(spawned.slice(2).map(s => s.command), runtimeInstalls.map(args => `npm.cmd ${args.join(' ')}`))
  assert.ok(spawned.every(s => s.shell === true && s.args.length === 0))
})

// ---- Both lines through the CLI with the real registry and the real migration -------------------------------------
const bothItem = selectedId => ({ ...item, choices: [
  { ...runtimeChoice, affectedConsumers: [{ location: 'node_modules/@angular/core', requestedName: 'vuln-dep', type: 'dependencies' }] },
  { ...choice, affectedConsumers: [{ location: 'node_modules/@angular/cli', requestedName: 'vuln-dep', type: 'dependencies' }] },
], id: selectedId })

async function runBoth(t, { platform = 'linux', steps } = {}) {
  const { main } = await import('../src/cli.js')
  const { itemId } = await import('../src/planner.js')
  const f = await webappFixture(t)
  const fake = webappRun(f.root, steps)
  const selected = bothItem(itemId(item.package, item.targetLocation))
  let stdout = '', stderr = ''
  const io = { stdout: { write: (s) => {
    stdout += s
  } }, stderr: { write: (s) => {
    stderr += s
  } } }
  const phases = []
  const deps = {
    preflightGit: async () => f.guard,
    readPlanner: async () => ({ rows: [selected] }),
    loadNpmContext: async () => ({ ...context }),
    readCatalog: webappCatalog(),
    readCandidateAdvisories: advisoriesFor(),
    readEvidence: () => assert.fail('the line phases clear the finding'),
    createStagingProject: () => assert.fail('must not stage'),
    migrateLine: (args) => {
      phases.push([args.line.name, args.guard.head, args.choice.affectedConsumers.map(consumer => consumer.location)])
      return migrateLine({ ...args, adapters: { ...args.adapters, run: fake.run, platform, readFreshAudit: async () => [] } })
    },
  }
  const code = await main([selected.id, '--format', 'json', '--module', 'webapp'], io, deps)
  return { f, fake, phases, code, stdout, stderr }
}

for (const platform of ['win32', 'linux']) test(`a toolchain and a runtime choice run both pre-phases in order with two commits (${platform})`, async (t) => {
  const x = await runBoth(t, { platform })
  assert.equal(x.code, 0, x.stderr)
  const subjects = (await git(x.f.repo, ['log', '-3', '--format=%s'])).trim().split('\n')
  assert.deepEqual(subjects, [`deps(webapp): bump Angular runtime to ${RT_NEW}`, `deps(webapp): migrate Angular toolchain to ${NEW}`, 'test: angular webapp'])
  const [runtimeHash, toolchainHash] = (await git(x.f.repo, ['log', '-2', '--format=%H'])).trim().split('\n')
  assert.deepEqual(x.phases.map(([name]) => name), ['toolchain', 'runtime'])
  assert.equal(x.phases[1][1], toolchainHash)
  assert.deepEqual(x.phases[1][2], ['node_modules/@angular/core'])
  assert.deepEqual(x.fake.calls.filter(c => c.command === 'npx').map(c => c.args.at(-1)), [`@angular/cli@${NEW}`, `@angular/core@${RT_NEW}`])
  // The toolchain install succeeds at once; only the runtime bump needs the -f fallback.
  assert.deepEqual(x.fake.calls.filter(c => c.command === 'npm' && c.args[0] !== 'ci').map(c => c.args), [context.installArgs, ...runtimeInstalls])
  const result = JSON.parse(x.stdout)
  assert.equal(result.resolution, 'complete')
  assert.deepEqual(result.actions.map(a => [a.strategy, a.targetVersion, a.outcome]), [[TOOLCHAIN_STRATEGY, NEW, 'applied'], [RUNTIME_STRATEGY, RT_NEW, 'applied']])
  assert.deepEqual(result.commits.map(c => [c.hash, c.actionIndex]), [[toolchainHash, 0], [runtimeHash, 1]])
  assert.equal(await status(x.f), '')
})

test('a failure in the runtime phase keeps and names the toolchain commit', async (t) => {
  const x = await runBoth(t, { steps: { migrate: async (root, args) => {
    await nxMigrate(root, args)
    if (args.at(-1).startsWith('@angular/core@')) await writeFile(path.join(root, 'migrations.json'), '{}\n')
    return { code: 0, stdout: '', stderr: '' }
  } } })
  assert.equal(x.code, 1)
  assert.equal(x.stdout, '')
  const toolchainHash = (await git(x.f.repo, ['rev-parse', 'HEAD'])).trim()
  assert.equal((await git(x.f.repo, ['log', '-1', '--format=%s'])).trim(), `deps(webapp): migrate Angular toolchain to ${NEW}`)
  assert.equal(x.stderr, `npm-dep-upgrade: migration: nx migrate generated migrations.json; migrate to ${RT_NEW} manually. Working tree restored. Completed commits: ${toolchainHash}. Dependency files were not changed after the toolchain commit. node_modules may have changed.\n`)
  assert.equal(await status(x.f), '')
  await assert.rejects(access(path.join(x.f.root, 'migrations.json')))
  assert.equal(JSON.parse(await readFile(path.join(x.f.root, 'package.json'), 'utf8')).dependencies['@angular/core'], RT_OLD)
})
