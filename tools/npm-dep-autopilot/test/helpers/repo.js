import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function commitFile(cwd, name, content, message = `add ${name}`) {
  writeFileSync(path.join(cwd, name), content)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-q', '-m', message)
}

export function createRepos(defaultBranch = 'main') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'autopilot-repo-'))
  const remote = path.join(root, 'remote.git')
  const clone = path.join(root, 'clone')
  const other = path.join(root, 'other')

  git(root, 'init', '-q', '--bare', '-b', defaultBranch, remote)
  git(root, 'clone', '-q', remote, clone)
  git(clone, 'config', 'user.name', 't')
  git(clone, 'config', 'user.email', 't@example.com')
  git(clone, 'checkout', '-q', '-B', defaultBranch)
  commitFile(clone, 'base.txt', 'base\n', 'initial')
  git(clone, 'push', '-q', '-u', 'origin', defaultBranch)
  git(root, 'clone', '-q', remote, other)
  git(other, 'config', 'user.name', 't')
  git(other, 'config', 'user.email', 't@example.com')

  return { root, remote, clone, other, defaultBranch }
}
