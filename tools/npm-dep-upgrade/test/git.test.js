import assert from 'node:assert/strict'
import { writeFile, readFile, unlink, symlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { preflightGit, assertGitState } from '../src/git.js'
import { gitProject, git } from './helpers/git-project.js'

test('Git guard allows unrelated unstaged work in a nested project', async (t) => {
  const f = await gitProject(t, { nested: true })
  await writeFile(path.join(f.repo, 'unrelated.txt'), 'user edit\n')
  const guard = await preflightGit(f.root)
  assert.equal(await realpath(guard.repoRoot), await realpath(f.repo))
  assert.match(guard.projectPrefix, /project with spaces/)
  await assertGitState(guard, 'before-write')
  assert.equal(await readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'user edit\n')
})
for (const variant of ['manifest', 'lock', 'staged-outside', 'detached', 'operation', 'symlink']) {
  test(`Git guard rejects ${variant} without erasing work`, async (t) => {
    const f = await gitProject(t, { nested: true })
    const manifest = path.join(f.root, 'package.json')
    if (variant === 'manifest') await writeFile(manifest, '{}\n')
    if (variant === 'lock') await writeFile(path.join(f.root, 'package-lock.json'), '{}\n')
    if (variant === 'staged-outside') {
      await writeFile(path.join(f.repo, 'unrelated.txt'), 'staged\n')
      await git(f.repo, ['add', 'unrelated.txt'])
    }
    if (variant === 'detached') await git(f.repo, ['checkout', '--detach'])
    if (variant === 'operation') await writeFile(path.join(f.repo, '.git', 'MERGE_HEAD'), 'x')
    if (variant === 'symlink') {
      await unlink(manifest)
      await symlink(path.join(f.repo, 'unrelated.txt'), manifest)
    }
    await assert.rejects(preflightGit(f.root), /clean|staging|branch|progress|regular|symlink/i)
  })
}
test('Git guard detects a new edit after preflight', async (t) => {
  const f = await gitProject(t)
  const guard = await preflightGit(f.root)
  await writeFile(path.join(f.root, 'package.json'), '{"user":"edit"}\n')
  await assert.rejects(assertGitState(guard, 'before-write'), /changed|concurrent/i)
})
test('commit stages only verified dependency files and preserves unrelated changes', async (t) => {
  const { commitUpgrade } = await import('../src/git.js')
  const f = await gitProject(t, { nested: true }), guard = await preflightGit(f.root)
  const { recordOwnedFiles } = await import('../src/recovery.js')
  const bytes = Buffer.from(JSON.stringify({ ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }, null, 2) + '\n')
  await writeFile(path.join(f.root, 'package.json'), bytes)
  await writeFile(path.join(f.repo, 'unrelated.txt'), 'keep edit\n')
  await recordOwnedFiles(guard, { 'package.json': bytes })
  const result = await commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' })
  assert.equal(result.subject, 'deps: bump e2e-target from 6.0.9 to 6.0.12')
  assert.match(result.hash, /^[a-f0-9]{40,64}$/)
  assert.deepEqual(result.changedFiles, ['package.json'])
  assert.equal(await readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'keep edit\n')
  assert.equal((await git(f.repo, ['diff', '--cached', '--name-only'])).trim(), '')
})
test('rejected commit hook leaves verified files but removes operation-owned staging', async (t) => {
  const { commitUpgrade } = await import('../src/git.js'), { recordOwnedFiles } = await import('../src/recovery.js')
  const { chmod } = await import('node:fs/promises')
  const f = await gitProject(t), guard = await preflightGit(f.root)
  const originalHead = guard.head
  const bytes = Buffer.from(JSON.stringify({ ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }) + '\n')
  await writeFile(path.join(f.root, 'package.json'), bytes)
  await recordOwnedFiles(guard, { 'package.json': bytes })
  const hook = path.join(f.repo, 'empty-hooks', 'pre-commit')
  await writeFile(hook, '#!/bin/sh\nexit 1\n')
  await chmod(hook, 0o755)
  await assert.rejects(commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' }), /commit failed/i)
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), originalHead)
  assert.deepEqual(await readFile(path.join(f.root, 'package.json')), bytes)
  assert.equal((await git(f.repo, ['diff', '--cached', '--name-only'])).trim(), '')
})
test('review branch switch at the same HEAD is detected', async (t) => {
  const f = await gitProject(t), guard = await preflightGit(f.root)
  await git(f.repo, ['switch', '-c', 'user-branch'])
  await assert.rejects(assertGitState(guard, 'before-write'), /branch|HEAD changed/i)
})
test('review clean CRLF files pass preflight and commit through Git clean filters', async (t) => {
  const { commitUpgrade } = await import('../src/git.js'), { recordOwnedFiles } = await import('../src/recovery.js')
  const f = await gitProject(t)
  await git(f.repo, ['config', 'core.autocrlf', 'true'])
  for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(f.root, name), (await readFile(path.join(f.root, name), 'utf8')).replaceAll('\n', '\r\n'))
  await git(f.repo, ['add', '-u'])
  assert.equal((await git(f.repo, ['status', '--porcelain'])).trim(), '')
  const guard = await preflightGit(f.root), bytes = Buffer.from(guard.originalFiles['package.json'].toString().replace('^6.0.8', '^6.0.12'))
  await writeFile(path.join(f.root, 'package.json'), bytes)
  await recordOwnedFiles(guard, { 'package.json': bytes })
  const result = await commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' })
  assert.ok(result.hash)
  assert.deepEqual(await readFile(path.join(f.root, 'package.json')), bytes)
})
test('review successful hook cannot include unrelated staged user work', async (t) => {
  const { commitUpgrade } = await import('../src/git.js'), { recordOwnedFiles } = await import('../src/recovery.js')
  const f = await gitProject(t), guard = await preflightGit(f.root)
  const bytes = Buffer.from(JSON.stringify({ ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }) + '\n')
  await writeFile(path.join(f.root, 'package.json'), bytes)
  await recordOwnedFiles(guard, { 'package.json': bytes })
  await writeFile(path.join(f.repo, 'unrelated.txt'), 'user edit\n')
  await writeFile(path.join(f.repo, 'empty-hooks', 'pre-commit'), '#!/bin/sh\ngit add -- unrelated.txt\n', { mode: 0o755 })
  await assert.rejects(commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' }), /commit|hook|staged/i)
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), guard.head)
  assert.equal((await git(f.repo, ['diff', '--cached', '--name-only'])).trim(), 'unrelated.txt')
})
for (const name of ['prepare-commit-msg', 'commit-msg']) test(`review ${name} hook changes cannot alter the verified tree or subject`, async (t) => {
  const { commitUpgrade } = await import('../src/git.js'), { recordOwnedFiles } = await import('../src/recovery.js')
  const f = await gitProject(t), guard = await preflightGit(f.root)
  const bytes = Buffer.from(JSON.stringify({ ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }) + '\n')
  await writeFile(path.join(f.root, 'package.json'), bytes)
  await recordOwnedFiles(guard, { 'package.json': bytes })
  const body = name === 'commit-msg' ? '#!/bin/sh\nprintf "different subject\\n" > "$1"\n' : '#!/bin/sh\nprintf "user work\\n" > unrelated.txt\ngit add -- unrelated.txt\n'
  await writeFile(path.join(f.repo, 'empty-hooks', name), body, { mode: 0o755 })
  await assert.rejects(commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' }), /commit|subject|staged/i)
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), guard.head)
})

for (const bypass of [false, true]) test(`custom subject preserves hook guards with no-verify=${bypass}`, async (t) => {
  const { commitUpgrade } = await import('../src/git.js'), { recordOwnedFiles } = await import('../src/recovery.js')
  const f = await gitProject(t), guard = await preflightGit(f.root)
  const manifest = Buffer.from(JSON.stringify({ ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }))
  await writeFile(path.join(f.root, 'package.json'), manifest)
  await recordOwnedFiles(guard, { 'package.json': manifest })
  for (const hook of ['pre-commit', 'commit-msg']) await writeFile(path.join(f.repo, 'empty-hooks', hook), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
  await writeFile(path.join(f.repo, 'empty-hooks', 'prepare-commit-msg'), '#!/bin/sh\nprintf prepared > prepared.txt\n', { mode: 0o755 })
  const operation = commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' }, { module: 'webapp', gitCommitArgs: bypass ? ['--no-verify', '--signoff'] : [] })
  if (!bypass) await assert.rejects(operation, /commit failed/i)
  else {
    const result = await operation
    assert.equal(result.subject, 'deps(webapp): bump e2e-target from 6.0.9 to 6.0.12')
    assert.equal(await readFile(path.join(f.repo, 'prepared.txt'), 'utf8'), 'prepared')
    assert.match(await git(f.repo, ['log', '-1', '--format=%B']), /Signed-off-by: Fixture <fixture@example.test>/)
  }
})

for (const mutation of ['subject', 'index', 'dependency']) test(`no-verify retains internal guard against prepare-commit-msg changing ${mutation}`, async (t) => {
  const { commitUpgrade } = await import('../src/git.js'), { recordOwnedFiles } = await import('../src/recovery.js')
  const f = await gitProject(t), guard = await preflightGit(f.root)
  const manifest = Buffer.from(JSON.stringify({ ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }))
  await writeFile(path.join(f.root, 'package.json'), manifest)
  await recordOwnedFiles(guard, { 'package.json': manifest })
  const body = mutation === 'subject' ? 'printf "other subject\\n" > "$1"' : mutation === 'index' ? 'git add -- unrelated.txt' : 'printf "changed\\n" >> package.json'
  if (mutation === 'index') await writeFile(path.join(f.repo, 'unrelated.txt'), 'user work\n')
  await writeFile(path.join(f.repo, 'empty-hooks', 'prepare-commit-msg'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  await assert.rejects(commitUpgrade(guard, guard.ownedFiles, { package: 'e2e-target', oldVersion: '6.0.9', newVersion: '6.0.12' }, { module: 'api', gitCommitArgs: ['--no-verify'] }), /commit|subject|staged/i)
  assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), guard.head)
})
