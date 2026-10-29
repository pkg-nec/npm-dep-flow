import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createGit } from '../src/git.js'
import { runProcess } from '../src/subprocess.js'
import { commitFile, createRepos, git } from './helpers/repo.js'

function adapter(repos) {
  return createGit({ run: runProcess, repo: repos.clone, defaultBranch: repos.defaultBranch })
}

test('syncDefault fast-forwards to origin and removes leftover deps branches', async () => {
  const repos = createRepos()
  git(repos.clone, 'checkout', '-q', '-b', 'deps/old')
  commitFile(repos.clone, 'local.txt', 'x')
  commitFile(repos.other, 'remote.txt', 'y')
  git(repos.other, 'push', '-q', 'origin', 'HEAD')
  const tool = adapter(repos)

  await tool.fetch()
  await tool.syncDefault()

  assert.equal(git(repos.clone, 'branch', '--show-current'), 'main')
  assert.equal(git(repos.clone, 'rev-parse', 'HEAD'), git(repos.clone, 'rev-parse', 'origin/main'))
  assert.equal(git(repos.clone, 'branch', '--list', 'deps/*'), '')
})

test('hasNewDefaultCommits is false until origin moves', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  await tool.createWorkBranch()
  commitFile(repos.clone, 'work.txt', 'w')
  await tool.fetch()
  assert.equal(await tool.hasNewDefaultCommits(), false)

  commitFile(repos.other, 'remote.txt', 'y')
  git(repos.other, 'push', '-q', 'origin', 'HEAD')
  await tool.fetch()
  assert.equal(await tool.hasNewDefaultCommits(), true)
})

test('rebaseOnDefault rebases non-conflicting work', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  await tool.createWorkBranch()
  commitFile(repos.clone, 'work.txt', 'w', 'work')
  commitFile(repos.other, 'remote.txt', 'y')
  git(repos.other, 'push', '-q', 'origin', 'HEAD')
  await tool.fetch()

  assert.equal(await tool.rebaseOnDefault(), true)
  assert.equal(await tool.hasNewDefaultCommits(), false)
  assert.deepEqual(await tool.subjectsSince(), ['work'])
})

test('rebaseOnDefault aborts on conflict and leaves the work branch intact', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  await tool.createWorkBranch()
  commitFile(repos.clone, 'base.txt', 'mine\n', 'mine')
  const before = git(repos.clone, 'rev-parse', 'HEAD')
  commitFile(repos.other, 'base.txt', 'theirs\n', 'theirs')
  git(repos.other, 'push', '-q', 'origin', 'HEAD')
  await tool.fetch()

  assert.equal(await tool.rebaseOnDefault(), false)
  assert.equal(git(repos.clone, 'rev-parse', 'HEAD'), before)
  assert.equal(git(repos.clone, 'status', '--porcelain'), '')
  assert.equal(git(repos.clone, 'branch', '--show-current'), 'deps/wip')
})

test('resetHard returns to a recorded head', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  await tool.createWorkBranch()
  const head = await tool.head()
  commitFile(repos.clone, 'extra.txt', 'x')

  await tool.resetHard(head)

  assert.equal(await tool.head(), head)
})

test('renameBranch and push publish the branch to the remote', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  await tool.createWorkBranch()
  commitFile(repos.clone, 'work.txt', 'w')

  await tool.renameBranch('deps/web/x-1.0.0')
  await tool.push('deps/web/x-1.0.0')

  assert.match(git(repos.remote, 'branch', '--list', 'deps/web/x-1.0.0'), /deps\/web\/x-1.0.0/)
})

test('isClean ignores untracked files but sees tracked modifications', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  writeFileSync(path.join(repos.clone, 'untracked.txt'), 'u')
  assert.equal(await tool.isClean(), true)

  writeFileSync(path.join(repos.clone, 'base.txt'), 'changed')
  assert.equal(await tool.isClean(), false)
})

test('push overwrites a stale remote branch of the same name', async () => {
  const repos = createRepos()
  git(repos.other, 'checkout', '-q', '-b', 'deps/web/x-1.0.0')
  commitFile(repos.other, 'stale.txt', 's')
  git(repos.other, 'push', '-q', 'origin', 'deps/web/x-1.0.0')
  const tool = adapter(repos)
  await tool.fetch()
  await tool.createWorkBranch()
  commitFile(repos.clone, 'work.txt', 'w')
  await tool.renameBranch('deps/web/x-1.0.0')

  await tool.push('deps/web/x-1.0.0')

  assert.equal(git(repos.remote, 'rev-parse', 'deps/web/x-1.0.0'), git(repos.clone, 'rev-parse', 'HEAD'))
})

test('onWorkBranch and discardWork recover an interrupted work branch', async () => {
  const repos = createRepos()
  const tool = adapter(repos)
  assert.equal(await tool.onWorkBranch(), false)

  await tool.createWorkBranch()
  writeFileSync(path.join(repos.clone, 'base.txt'), 'half-written')
  writeFileSync(path.join(repos.clone, 'migrations.json'), '{}')
  assert.equal(await tool.onWorkBranch(), true)
  assert.equal(await tool.isClean(), false)

  await tool.discardWork()

  assert.equal(git(repos.clone, 'status', '--porcelain'), '')
})

test('assertIdentity rejects with GIT_IDENTITY when git cannot determine a committer', async () => {
  const run = async () => ({ code: 128, stdout: '', stderr: 'fatal: unable to auto-detect email address' })

  await assert.rejects(createGit({ run, repo: '/repo', defaultBranch: 'main' }).assertIdentity(), (error) => {
    assert.equal(error.code, 'GIT_IDENTITY')
    assert.match(error.message, /user\.name/)
    return true
  })
})

test('assertIdentity passes when the clone has a committer identity', async () => {
  await adapter(createRepos()).assertIdentity()
})
