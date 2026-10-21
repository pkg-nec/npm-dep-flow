import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readContext } from '../src/context.js'
import { execute, scratch, registryEnv } from './helpers/commands.js'

for (const variable of ['NPM_DEP_UPGRADE_E2E_NPM_CLI', 'NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI']) {
  const runtime = process.env[variable]
  test(`real npm credential rotation invalidates identity without retaining secrets (${variable})`, { skip: !runtime }, async (t) => {
    const root = await scratch(t)
    const config = join(root, '.npmrc')
    const env = registryEnv(root, 'https://registry.example/')
    const run = async (_command, args, cwd) => {
      const result = await execute(process.execPath, [runtime, ...args], { cwd, env })
      return { ...result, code: 0 }
    }
    await writeFile(config, '//registry.example/:_authToken=FIRST_PRIVATE_TOKEN\n')
    const first = await readContext(root, run, env)
    await writeFile(config, '//registry.example/:_authToken=SECOND_PRIVATE_TOKEN\n')
    const second = await readContext(root, run, env)
    assert.notEqual(first.configHash, second.configHash)
    await writeFile(config, '//registry.example/:_authToken=${CATALOG_PRIVATE_TOKEN}\n')
    env.CATALOG_PRIVATE_TOKEN = 'ENV_PRIVATE_A'
    const a = await readContext(root, run, env)
    env.CATALOG_PRIVATE_TOKEN = 'ENV_PRIVATE_B'
    const b = await readContext(root, run, env)
    assert.notEqual(a.configHash, b.configHash)
    assert.doesNotMatch(JSON.stringify([first, second, a, b]), /FIRST_PRIVATE|SECOND_PRIVATE|ENV_PRIVATE/)
  })
}
