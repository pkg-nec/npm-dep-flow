import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPlanningContext } from '../src/context.js'

const execute = promisify(execFile)
const runtime = process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI

test('planner result identity changes with protected registry credentials and environment substitutions', { skip: !runtime }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'planner-auth-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'userconfig')
  const env = { ...process.env, npm_config_userconfig: file, npm_config_registry: 'https://registry.example/', npm_config_cache: join(root, 'npm-cache') }
  const run = async (command, args, cwd) => {
    if (command !== 'npm') return { code: 0, stdout: `${command} v1.0.0\nLocation: fixture` }
    const result = await execute(process.execPath, [runtime, ...args], { cwd, env })
    return { ...result, code: 0 }
  }
  await writeFile(file, '//registry.example/:_authToken=FIRST_PRIVATE\n')
  const first = await readPlanningContext(root, run, env)
  await writeFile(file, '//registry.example/:_authToken=SECOND_PRIVATE\n')
  const second = await readPlanningContext(root, run, env)
  assert.notEqual(first.configHash, second.configHash)
  await writeFile(file, '//registry.example/:_authToken=${PLANNER_PRIVATE_TOKEN}\n')
  env.PLANNER_PRIVATE_TOKEN = 'PRIVATE_A'
  const a = await readPlanningContext(root, run, env)
  env.PLANNER_PRIVATE_TOKEN = 'PRIVATE_B'
  const b = await readPlanningContext(root, run, env)
  assert.notEqual(a.configHash, b.configHash)
  assert.doesNotMatch(JSON.stringify([first, second, a, b]), /FIRST_PRIVATE|SECOND_PRIVATE|PRIVATE_A|PRIVATE_B/)
})
