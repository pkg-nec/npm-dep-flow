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
test('commit stages only verified dependency files and preserves unrelated changes',async t=>{
 const {commitUpgrade}=await import('../src/git.js')
 const f=await gitProject(t,{nested:true}),guard=await preflightGit(f.root)
 const {recordOwnedFiles}=await import('../src/recovery.js')
 const bytes=Buffer.from(JSON.stringify({...f.manifest,dependencies:{'e2e-target':'^6.0.12'}},null,2)+'\n')
 await writeFile(path.join(f.root,'package.json'),bytes)
 await writeFile(path.join(f.repo,'unrelated.txt'),'keep edit\n')
 await recordOwnedFiles(guard,{'package.json':bytes})
 const result=await commitUpgrade(guard,guard.ownedFiles,{package:'e2e-target',oldVersion:'6.0.9',newVersion:'6.0.12'})
 assert.equal(result.subject,'deps: bump e2e-target from 6.0.9 to 6.0.12')
 assert.match(result.hash,/^[a-f0-9]{40,64}$/)
 assert.deepEqual(result.changedFiles,['package.json'])
 assert.equal(await readFile(path.join(f.repo,'unrelated.txt'),'utf8'),'keep edit\n')
 assert.equal((await git(f.repo,['diff','--cached','--name-only'])).trim(),'')
})
test('rejected commit hook leaves verified files but removes operation-owned staging',async t=>{
 const {commitUpgrade}=await import('../src/git.js'),{recordOwnedFiles}=await import('../src/recovery.js')
 const {chmod}=await import('node:fs/promises')
 const f=await gitProject(t),guard=await preflightGit(f.root)
 const originalHead=guard.head
 const bytes=Buffer.from(JSON.stringify({...f.manifest,dependencies:{'e2e-target':'^6.0.12'}})+'\n')
 await writeFile(path.join(f.root,'package.json'),bytes)
 await recordOwnedFiles(guard,{'package.json':bytes})
 const hook=path.join(f.repo,'empty-hooks','pre-commit')
 await writeFile(hook,'#!/bin/sh\nexit 1\n');await chmod(hook,0o755)
 await assert.rejects(commitUpgrade(guard,guard.ownedFiles,{package:'e2e-target',oldVersion:'6.0.9',newVersion:'6.0.12'}),/commit failed/i)
 assert.equal((await git(f.repo,['rev-parse','HEAD'])).trim(),originalHead)
 assert.deepEqual(await readFile(path.join(f.root,'package.json')),bytes)
 assert.equal((await git(f.repo,['diff','--cached','--name-only'])).trim(),'')
})
