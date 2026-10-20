import assert from 'node:assert/strict'
import { writeFile, readFile, unlink, symlink } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { preflightGit, assertGitState } from '../src/git.js'
import { gitProject, git } from './helpers/git-project.js'

test('Git guard allows unrelated unstaged work in a nested project', async t => {
  const f = await gitProject(t, { nested: true })
  await writeFile(path.join(f.repo, 'unrelated.txt'), 'user edit\n')
  const guard = await preflightGit(f.root)
  assert.equal(guard.repoRoot, f.repo)
  assert.match(guard.projectPrefix, /project with spaces/)
  await assertGitState(guard, 'before-write')
  assert.equal(await readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'user edit\n')
})
for (const variant of ['manifest', 'lock', 'staged-outside', 'detached', 'operation', 'symlink']) {
  test(`Git guard rejects ${variant} without erasing work`, async t => {
    const f = await gitProject(t, { nested: true })
    const manifest = path.join(f.root, 'package.json')
    if (variant === 'manifest') await writeFile(manifest, '{}\n')
    if (variant === 'lock') await writeFile(path.join(f.root, 'package-lock.json'), '{}\n')
    if (variant === 'staged-outside') { await writeFile(path.join(f.repo, 'unrelated.txt'), 'staged\n'); await git(f.repo, ['add', 'unrelated.txt']) }
    if (variant === 'detached') await git(f.repo, ['checkout', '--detach'])
    if (variant === 'operation') await writeFile(path.join(f.repo, '.git', 'MERGE_HEAD'), 'x')
    if (variant === 'symlink') { await unlink(manifest); await symlink(path.join(f.repo, 'unrelated.txt'), manifest) }
    await assert.rejects(preflightGit(f.root), /clean|staging|branch|progress|regular|symlink/i)
  })
}
test('Git guard detects a new edit after preflight', async t => {
  const f = await gitProject(t)
  const guard = await preflightGit(f.root)
  await writeFile(path.join(f.root, 'package.json'), '{"user":"edit"}\n')
  await assert.rejects(assertGitState(guard, 'before-write'), /changed|concurrent/i)
})
