import { lstat, readFile, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runProcess } from './process.js'
import { fail } from './errors.js'
import { formatCommitMessage } from './commit-message.js'
import { validateCommitArgs } from './config.js'

const line = s => s.replace(/\r?\n$/, '')
const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
export async function runGit(root, args) {
  const r = await runProcess('git', args, { cwd: root })
  if (r.code) fail('GIT_ERROR', 'git', `git ${args[0] === '-c' ? args[2] : args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  return r.stdout
}
export async function readDependencyFiles(root) {
  const files = {}
  for (const name of ['package.json', 'package-lock.json']) {
    let stat
    try {
      stat = await lstat(path.join(root, name))
    }
    catch { fail('GIT_PRECONDITION', 'git', `${name} must be a tracked regular file`) }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('GIT_PRECONDITION', 'git', `${name} must be a nonsymlink regular file`)
    files[name] = await readFile(path.join(root, name))
  }
  return files
}

async function assertNoOperation(repoRoot, phase) {
  for (const op of operations) {
    const file = line(await runGit(repoRoot, ['rev-parse', '--git-path', op]))
    try {
      await lstat(path.resolve(repoRoot, file))
      fail('GIT_PRECONDITION', phase, 'Git operation already in progress')
    }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

async function assertRepositoryState(guard, phase, { staged = false } = {}) {
  if (line(await runGit(guard.repoRoot, ['rev-parse', 'HEAD'])) !== guard.head) fail('CONCURRENT_CHANGE', phase, 'Git HEAD changed during upgrade')
  const branch = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: guard.repoRoot })
  if (branch.code || line(branch.stdout) !== guard.branch) fail('CONCURRENT_CHANGE', phase, 'Git branch changed during upgrade')
  await assertNoOperation(guard.repoRoot, phase)
  if (!staged && (await runGit(guard.repoRoot, ['diff', '--cached', '--name-only', '-z'])).length) fail('CONCURRENT_CHANGE', phase, 'Git staging area changed; it must be empty')
}

export async function assertGitState(guard, phase, expectedFiles = guard.ownedFiles) {
  await assertRepositoryState(guard, phase)
  const files = await readDependencyFiles(guard.root)
  for (const name of Object.keys(files)) if (!files[name].equals(expectedFiles[name])) fail('CONCURRENT_CHANGE', phase, `${name} changed outside this operation`)
}
const filteredBlob = async (root, file) => line(await runGit(root, ['hash-object', `--path=${file}`, file]))
export async function preflightGit(projectRoot) {
  const root = await realpath(projectRoot)
  const repoRoot = line(await runGit(root, ['rev-parse', '--show-toplevel']))
  const branchResult = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot })
  if (branchResult.code) fail('GIT_PRECONDITION', 'git', 'Upgrade requires a local branch, not detached HEAD')
  const head = line(await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']))
  if ((await runGit(repoRoot, ['diff', '--cached', '--name-only', '-z'])).length) fail('GIT_PRECONDITION', 'git', 'Git staging area must be empty')
  await assertNoOperation(repoRoot, 'git')
  for (const id of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) if ((await runProcess('git', ['var', id], { cwd: repoRoot })).code) fail('GIT_PRECONDITION', 'git', 'Git author/committer identity is required')
  const projectPrefix = path.relative(repoRoot, root).split(path.sep).join('/')
  const names = ['package.json', 'package-lock.json']
  const dependencyPaths = names.map(name => projectPrefix ? `${projectPrefix}/${name}` : name)
  const originalFiles = await readDependencyFiles(root)
  for (let i = 0; i < names.length; i++) {
    const tracked = await runProcess('git', ['ls-files', '--error-unmatch', '--', dependencyPaths[i]], { cwd: repoRoot })
    if (tracked.code) fail('GIT_PRECONDITION', 'git', `${names[i]} must be clean and tracked`)
    const committed = line(await runGit(repoRoot, ['rev-parse', `HEAD:${dependencyPaths[i]}`]))
    if (await filteredBlob(repoRoot, dependencyPaths[i]) !== committed) fail('GIT_PRECONDITION', 'git', `${names[i]} must be clean before starting`)
  }
  return { root, repoRoot, projectPrefix, head, branch: line(branchResult.stdout), dependencyPaths, originalFiles, ownedFiles: { ...originalFiles }, installedTreeMayHaveChanged: false }
}
// Called after each normal pre-commit/message hook, before Git creates a commit.
export async function assertCommitState(guard, paths, blobs) {
  await assertRepositoryState(guard, 'commit', { staged: true })
  const current = await readDependencyFiles(guard.root)
  for (const name of Object.keys(current)) if (!current[name].equals(guard.ownedFiles[name])) fail('CONCURRENT_CHANGE', 'commit', 'Hook changed verified dependency files')
  const staged = (await runGit(guard.repoRoot, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  if (staged.length !== paths.length || staged.some(p => !paths.includes(p))) fail('CONCURRENT_CHANGE', 'commit', 'Hook changed staged files outside verified scope')
  for (const file of paths) if (line(await runGit(guard.repoRoot, ['rev-parse', `:${file}`])) !== blobs[file]) fail('CONCURRENT_CHANGE', 'commit', 'Hook changed verified staged content')
}

async function createCommitHooks(guard, paths, blobs, subject) {
  const directory = await mkdtemp(path.join(tmpdir(), 'npm-dep-upgrade-hooks-'))
  try {
    const original = line(await runGit(guard.repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']))
    const snapshot = path.join(directory, 'snapshot.json')
    await writeFile(snapshot, JSON.stringify({ guard: { ...guard, ownedFiles: Object.fromEntries(Object.entries(guard.ownedFiles).map(([name, bytes]) => [name, bytes.toString('base64')])) }, paths, blobs, subject, original }), { mode: 0o600 })
    const runner = fileURLToPath(new URL('./hook-runner.js', import.meta.url))
    const quote = value => '\'' + value.replaceAll('\'', '\'\\\'\'') + '\''
    // Git executes hooks through its POSIX shell on Windows as well. Use forward
    // slashes there so a quoted drive path remains executable by Git's shell.
    const commandPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/') : value
    for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      await writeFile(path.join(directory, name), `#!/bin/sh\nexec ${quote(commandPath(process.execPath))} ${quote(commandPath(runner))} ${quote(commandPath(snapshot))} ${quote(name)} "$@"\n`, { mode: 0o755 })
    }
    return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) }
  }
  catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function commitUpgrade(guard, expectedFiles, identity, options = {}) {
  const subject = formatCommitMessage(identity, options)
  const args = options.gitCommitArgs ?? []
  validateCommitArgs(args)
  await assertGitState(guard, 'before-commit', expectedFiles)
  const names = ['package.json', 'package-lock.json'].filter(name => !guard.originalFiles[name].equals(expectedFiles[name]))
  if (!names.length) fail('NO_CHANGES', 'commit', 'No dependency changes to commit')
  const paths = names.map(name => guard.projectPrefix ? `${guard.projectPrefix}/${name}` : name)
  const blobs = Object.fromEntries(await Promise.all(paths.map(async file => [file, await filteredBlob(guard.repoRoot, file)])))
  let hooks, createdCommit
  try {
    await runGit(guard.repoRoot, ['add', '--', ...paths])
    await assertCommitState(guard, paths, blobs)
    hooks = await createCommitHooks(guard, paths, blobs, subject)
    await runGit(guard.repoRoot, ['-c', `core.hooksPath=${hooks.directory}`, 'commit', ...args, '-m', subject])
    const hash = line(await runGit(guard.repoRoot, ['rev-parse', 'HEAD']))
    const parent = line(await runGit(guard.repoRoot, ['rev-parse', `${hash}^`]))
    const actualSubject = line(await runGit(guard.repoRoot, ['log', '-1', '--format=%s']))
    const branch = line(await runGit(guard.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']))
    const committed = (await runGit(guard.repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', hash])).split('\0').filter(Boolean)
    if (parent !== guard.head || branch !== guard.branch || actualSubject !== subject || committed.length !== paths.length || committed.some(p => !paths.includes(p))) fail('COMMIT_MISMATCH', 'commit', `Unexpected commit state; inspect ${hash}`)
    for (let i = 0; i < names.length; i++) {
      if (line(await runGit(guard.repoRoot, ['rev-parse', `${hash}:${paths[i]}`])) !== blobs[paths[i]]) fail('COMMIT_MISMATCH', 'commit', 'Committed dependency files differ from verified contents')
    }
    createdCommit = { hash, subject, changedFiles: names }
    const current = await readDependencyFiles(guard.root)
    for (const name of names) {
      if (!current[name].equals(expectedFiles[name])) fail('COMMIT_MISMATCH', 'commit', 'Dependency files changed after commit')
    }
    return createdCommit
  }
  catch (error) {
    if (line(await runGit(guard.repoRoot, ['rev-parse', 'HEAD'])) === guard.head) {
      for (const file of paths) {
        const indexed = await runProcess('git', ['rev-parse', `:${file}`], { cwd: guard.repoRoot })
        if (!indexed.code && line(indexed.stdout) === blobs[file]) await runGit(guard.repoRoot, ['restore', '--staged', '--', file])
      }
    }
    Object.assign(error, { stage: 'commit', changesRemainUncommitted: true, ...(createdCommit ? { createdCommit } : {}) })
    throw error
  }
  finally { if (hooks) await hooks.cleanup() }
}
