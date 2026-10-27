import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertGitState } from './git.js'
import { fail } from './errors.js'

export async function recordOwnedFiles(guard, files) {
  for (const [name, expected] of Object.entries(files)) {
    if (!Object.hasOwn(guard.originalFiles, name)) fail('OWNERSHIP_ERROR', 'recovery', 'Unknown dependency file')
    if (!(await readFile(path.join(guard.root, name))).equals(expected)) fail('CONCURRENT_CHANGE', 'recovery', `${name} changed before ownership could be recorded`)
    guard.ownedFiles[name] = Buffer.from(expected)
  }
}
export async function restoreDependencyFiles(guard) {
  await assertGitState(guard, 'recovery')
  for (const [name, bytes] of Object.entries(guard.originalFiles)) await writeFile(path.join(guard.root, name), bytes)
  guard.ownedFiles = { ...guard.originalFiles }
  return { filesRestored: true, installedTreeMayHaveChanged: guard.installedTreeMayHaveChanged }
}
