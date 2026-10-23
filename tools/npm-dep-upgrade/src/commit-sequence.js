import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertGitState, commitUpgrade } from './git.js'
import { recordOwnedFiles } from './recovery.js'
export async function commitSnapshots(guard, snapshots, actions, context, options, adapters) {
  const commits = []
  let activeSnapshot
  try {
    for (const snapshot of snapshots) {
      activeSnapshot = snapshot
      await assertGitState(guard, 'before-snapshot')
      for (const [name, bytes] of Object.entries(snapshot.files)) {
        await assertGitState(guard, 'before-snapshot-write')
        await writeFile(path.join(guard.root, name), bytes)
        await recordOwnedFiles(guard, { [name]: bytes })
      }
      await adapters.prepareSnapshot(snapshot)
      await assertGitState(guard, 'before-snapshot-commit')
      const action = actions[snapshot.choiceIndex]
      const committed = await (adapters.commitUpgrade || commitUpgrade)(guard, snapshot.files, { package: action.targetPackage, oldVersion: action.currentVersion, newVersion: action.targetVersion, strategy: action.strategy, description: `bump ${action.targetPackage} from ${action.currentVersion} to ${action.targetVersion}` }, options)
      commits.push({ ...committed, actionIndex: snapshot.choiceIndex })
      guard.head = committed.hash
      guard.originalFiles = { ...snapshot.files }
      guard.ownedFiles = { ...snapshot.files }
    }
    return commits
  }
  catch (error) {
    if (error.createdCommit) commits.push({ ...error.createdCommit, actionIndex: activeSnapshot.choiceIndex })
    error.committed = commits
    if (commits.length) error.message += `; completed commits: ${commits.map(c => c.hash).join(', ')}. Remaining verified dependency changes may be uncommitted`
    throw error
  }
}
