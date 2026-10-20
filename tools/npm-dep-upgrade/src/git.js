import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './process.js'
import { fail } from './errors.js'
export async function runGit(root, args) {
  const r = await runProcess('git', args, { cwd: root })
  if (r.code) fail('GIT_ERROR', 'git', `git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  return r.stdout
}
const line = s => s.replace(/\r?\n$/, '')
export async function readDependencyFiles(root) {
  const files = {}
  for (const name of ['package.json', 'package-lock.json']) {
    let stat
    try { stat = await lstat(path.join(root, name)) } catch { fail('GIT_PRECONDITION', 'git', `${name} must be a tracked regular file`) }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('GIT_PRECONDITION', 'git', `${name} must be a nonsymlink regular file`)
    files[name] = await readFile(path.join(root, name))
  }
  return files
}
export async function assertGitState(guard, phase, expectedFiles = guard.ownedFiles) {
  if (line(await runGit(guard.repoRoot, ['rev-parse', 'HEAD'])) !== guard.head) fail('CONCURRENT_CHANGE', phase, 'Git HEAD changed during upgrade')
  if ((await runGit(guard.repoRoot, ['diff', '--cached', '--name-only', '-z'])).length) fail('CONCURRENT_CHANGE', phase, 'Git staging area changed; it must be empty')
  const files = await readDependencyFiles(guard.root)
  for (const name of Object.keys(files)) if (!files[name].equals(expectedFiles[name])) fail('CONCURRENT_CHANGE', phase, `${name} changed outside this operation`)
}
export async function preflightGit(projectRoot) {
  const root = await realpath(projectRoot)
  const repoRoot = line(await runGit(root, ['rev-parse', '--show-toplevel']))
  const branchResult = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot })
  if (branchResult.code) fail('GIT_PRECONDITION', 'git', 'Upgrade requires a local branch, not detached HEAD')
  const head = line(await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']))
  if ((await runGit(repoRoot, ['diff', '--cached', '--name-only', '-z'])).length) fail('GIT_PRECONDITION', 'git', 'Git staging area must be empty')
  for (const op of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const file = line(await runGit(repoRoot, ['rev-parse', '--git-path', op]))
    try { await lstat(path.resolve(repoRoot, file)); fail('GIT_PRECONDITION', 'git', 'Git operation already in progress') }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  for (const id of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    if ((await runProcess('git', ['var', id], { cwd: repoRoot })).code) fail('GIT_PRECONDITION', 'git', 'Git author/committer identity is required')
  }
  const projectPrefix = path.relative(repoRoot, root).split(path.sep).join('/')
  const names = ['package.json', 'package-lock.json']
  const dependencyPaths = names.map(name => projectPrefix ? `${projectPrefix}/${name}` : name)
  const originalFiles = await readDependencyFiles(root)
  for (let i = 0; i < names.length; i++) {
    const tracked = await runProcess('git', ['ls-files', '--error-unmatch', '--', dependencyPaths[i]], { cwd: repoRoot })
    if (tracked.code) fail('GIT_PRECONDITION', 'git', `${names[i]} must be clean and tracked`)
    const committed = await runGit(repoRoot, ['show', `HEAD:${dependencyPaths[i]}`])
    if (!originalFiles[names[i]].equals(Buffer.from(committed))) fail('GIT_PRECONDITION', 'git', `${names[i]} must be clean before starting`)
  }
  return { root, repoRoot, projectPrefix, head, branch: line(branchResult.stdout), dependencyPaths, originalFiles, ownedFiles: { ...originalFiles }, installedTreeMayHaveChanged: false }
}
