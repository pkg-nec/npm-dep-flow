import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { gitProject } from './helpers/git-project.js'
import { preflightGit, runGit } from '../src/git.js'
import { commitSnapshots } from '../src/commit-sequence.js'

test('commits each verified dependency snapshot separately', async (t) => {
  const f = await gitProject(t), guard = await preflightGit(f.root)
  const snapshots = ['6.0.10', '6.0.12'].map((version, choiceIndex) => {
    const manifest = { ...f.manifest, dependencies: { 'e2e-target': '^' + version } }, lock = structuredClone(f.lock)
    lock.packages[''] = manifest
    lock.packages['node_modules/e2e-target'].version = version
    return { choiceIndex, files: { 'package.json': Buffer.from(JSON.stringify(manifest)), 'package-lock.json': Buffer.from(JSON.stringify(lock)) } }
  })
  const actions = ['6.0.10', '6.0.12'].map((targetVersion, i) => ({ strategy: 'update-within-declared-range', targetPackage: 'e2e-target', currentVersion: i ? '6.0.10' : '6.0.9', targetVersion }))
  const commits = await commitSnapshots(guard, snapshots, actions, {}, {}, { prepareSnapshot: async () => {} })
  assert.equal(commits.length, 2)
  assert.deepEqual(commits.map(c => c.actionIndex), [0, 1])
  assert.equal((await runGit(f.root, ['log', '-1', '--format=%s'])).trim(), 'deps: bump e2e-target from 6.0.10 to 6.0.12')
  for (let i = 0;

    i < 2;

    i++) assert.equal(await runGit(f.root, ['show', `${commits[i].hash}:package-lock.json`]), snapshots[i].files['package-lock.json'].toString())
  assert.deepEqual(await readFile(f.root + '/package.json'), snapshots[1].files['package.json'])
})
test('preserves the first commit when the second commit hook rejects', async (t) => {
  const { writeFile } = await import('node:fs/promises')
  const f = await gitProject(t), guard = await preflightGit(f.root), initial = guard.head
  await writeFile(f.repo + '/empty-hooks/pre-commit', '#!/bin/sh\ncase "$(git log -1 --format=%s)" in *6.0.10*) exit 1;; esac\n', { mode: 0o755 })
  const snapshots = ['6.0.10', '6.0.12'].map((version, choiceIndex) => {
    const manifest = { ...f.manifest, dependencies: { 'e2e-target': '^' + version } }, lock = structuredClone(f.lock)
    lock.packages[''] = manifest
    lock.packages['node_modules/e2e-target'].version = version
    return { choiceIndex, files: { 'package.json': Buffer.from(JSON.stringify(manifest)), 'package-lock.json': Buffer.from(JSON.stringify(lock)) } }
  })
  const actions = ['6.0.10', '6.0.12'].map(targetVersion => ({ strategy: 'update-within-declared-range', targetPackage: 'e2e-target', currentVersion: '6.0.9', targetVersion }))
  await assert.rejects(commitSnapshots(guard, snapshots, actions, {}, {}, { prepareSnapshot: async () => {} }), error => error.committed.length === 1 && error.message.includes(error.committed[0].hash))
  assert.equal((await runGit(f.root, ['rev-list', '--count', `${initial}..HEAD`])).trim(), '1')
  assert.equal((await runGit(f.root, ['diff', '--cached', '--name-only'])).trim(), '')
  assert.deepEqual(await readFile(f.root + '/package.json'), snapshots[1].files['package.json'])
})

test('reports a created commit when post-commit file verification fails', async (t) => {
  const { writeFile } = await import('node:fs/promises')
  const f = await gitProject(t), guard = await preflightGit(f.root), initial = guard.head
  const manifest = { ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }, lock = structuredClone(f.lock)
  lock.packages[''] = manifest
  lock.packages['node_modules/e2e-target'].version = '6.0.12'
  const snapshot = { choiceIndex: 0, files: { 'package.json': Buffer.from(JSON.stringify(manifest)), 'package-lock.json': Buffer.from(JSON.stringify(lock)) } }
  await writeFile(f.repo + '/empty-hooks/post-commit', '#!/bin/sh\nprintf "\\n" >> package-lock.json\n', { mode: 0o755 })
  let failure
  try {
    await commitSnapshots(guard, [snapshot], [{ strategy: 'update-within-declared-range', targetPackage: 'e2e-target', currentVersion: '6.0.9', targetVersion: '6.0.12' }], {}, {}, { prepareSnapshot: async () => {} })
  }
  catch (error) { failure = error }
  assert.ok(failure)
  const head = (await runGit(f.root, ['rev-parse', 'HEAD'])).trim()
  assert.notEqual(head, initial)
  assert.equal(failure.committed.length, 1)
  assert.equal(failure.committed[0].hash, head)
  assert.ok(failure.message.includes(head))
  assert.deepEqual(await readFile(f.root + '/package-lock.json'), Buffer.concat([snapshot.files['package-lock.json'], Buffer.from('\n')]))
})
