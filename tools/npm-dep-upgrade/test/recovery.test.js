import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { preflightGit } from '../src/git.js'
import { recordOwnedFiles, restoreDependencyFiles } from '../src/recovery.js'
import { gitProject } from './helpers/git-project.js'

test('recovery restores only operation-owned dependency files', async (t) => {
  const f = await gitProject(t)
  const guard = await preflightGit(f.root)
  const file = path.join(f.root, 'package.json')
  const old = await readFile(file)
  const edited = Buffer.from('{"operation":"edit"}\n')
  await writeFile(file, edited)
  await recordOwnedFiles(guard, { 'package.json': edited })
  const result = await restoreDependencyFiles(guard)
  assert.equal(result.filesRestored, true)
  assert.deepEqual(await readFile(file), old)
})
test('recovery refuses to overwrite a concurrent edit', async (t) => {
  const f = await gitProject(t)
  const guard = await preflightGit(f.root)
  const file = path.join(f.root, 'package.json')
  await writeFile(file, '{"user":"concurrent"}\n')
  await assert.rejects(restoreDependencyFiles(guard), /concurrent|ownership|changed/i)
  assert.match(await readFile(file, 'utf8'), /concurrent/)
})
