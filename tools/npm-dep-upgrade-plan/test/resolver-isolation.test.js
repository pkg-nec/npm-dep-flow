import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('optional resolver tests load with only planner dependencies installed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'planner-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(path.join(root, 'test'))
  await Promise.all(['src', 'node_modules', 'package.json', 'test/resolver.integration.test.js'].map(name => cp(path.join(source, name), path.join(root, name), { recursive: true })))
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NPM_DEP_UPGRADE_E2E_NPM_CLI
  delete env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI
  const result = spawnSync(process.execPath, ['--test', 'test/resolver.integration.test.js'], { cwd: root, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
})
