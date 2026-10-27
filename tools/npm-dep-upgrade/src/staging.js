import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// npm owns this private project. Real project bytes are never inferred from npm's
// semantic output: they must still match the Git guard before publication.
export async function createStagingProject(project, context) {
  const root = await mkdtemp(path.join(tmpdir(), 'npm-dep-upgrade-stage-'))
  try {
    await writeFile(path.join(root, 'package.json'), project.manifestBytes)
    await writeFile(path.join(root, 'package-lock.json'), project.lockBytes)
    try {
      await writeFile(path.join(root, '.npmrc'), await readFile(path.join(project.root, '.npmrc')), { mode: 0o600 })
    }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return { root, cleanup: () => rm(root, { recursive: true, force: true }), context: { ...context, installArgs: [...context.installArgs, ...(context.stagingPathArgs || [])], projectRoot: root } }
  }
  catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
