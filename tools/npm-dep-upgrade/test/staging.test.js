import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { gitProject } from './helpers/git-project.js'
import { loadProject } from '../src/project.js'
import { createStagingProject } from '../src/staging.js'
test('private npm project preserves config and anchored path options', async (t) => {
  const f = await gitProject(t), project = await loadProject(f.root), cache = path.join(f.root, 'relative-cache')
  await writeFile(path.join(f.root, '.npmrc'), 'registry=https://registry.example/\ncache=./relative-cache\n')
  const staging = await createStagingProject(project, { installArgs: ['install', '--ignore-scripts'], stagingPathArgs: [`--cache=${cache}`] })
  t.after(staging.cleanup)
  assert.notEqual(staging.root, project.root)
  assert.ok(staging.context.installArgs.includes(`--cache=${cache}`))
  assert.deepEqual(await readFile(path.join(staging.root, 'package.json')), project.manifestBytes)
  assert.equal(await readFile(path.join(staging.root, '.npmrc'), 'utf8'), 'registry=https://registry.example/\ncache=./relative-cache\n')
})
