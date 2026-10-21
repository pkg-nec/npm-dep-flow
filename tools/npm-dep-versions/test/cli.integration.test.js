import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readdir } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute, scratch, registryEnv, npmCommandDirectory } from './helpers/commands.js'
import { fixtureRegistry } from './helpers/registry.js'

const runtime = process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI
test('real executable shares one combined fetch across stable, prerelease, major, range and output views', { skip: !runtime }, async (t) => {
  const root = await scratch(t)
  const project = join(root, 'context with spaces')
  await mkdir(project)
  const registry = await fixtureRegistry(t)
  const commands = await npmCommandDirectory(root, runtime)
  const env = { ...registryEnv(root, registry.url), PATH: commands + delimiter + process.env.PATH, XDG_CACHE_HOME: join(root, 'catalog-cache') }
  const bin = fileURLToPath(new URL('../bin/npm-dep-versions.js', import.meta.url))
  const run = args => execute(process.execPath, [bin, 'fixture-package', '--project', project, ...args], { env })
  const first = await run(['--format', 'json', '--debug'])
  assert.equal(JSON.parse(first.stdout).rows.length, 1)
  assert.match(first.stderr, /cache miss catalog/)
  const all = await run(['--all', '--format', 'json', '--debug'])
  assert.equal(JSON.parse(all.stdout).rows.length, 2)
  assert.match(all.stderr, /cache hit catalog/)
  assert.equal(JSON.parse(all.stdout).fetchedAt, JSON.parse(first.stdout).fetchedAt)
  assert.match((await run(['--major', '1'])).stdout, /1\.0\.0/)
  assert.equal(JSON.parse((await run(['--range', '>=2', '--format', 'json'])).stdout).rows.length, 0)
  assert.equal(registry.calls.length, 1)
  await run(['--no-cache'])
  assert.equal(registry.calls.length, 2)
  assert.deepEqual(await readdir(project), [])
})

for (const variable of ['NPM_DEP_UPGRADE_E2E_NPM_CLI', 'NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI']) {
  const npmRuntime = process.env[variable]
  test(`workspace-member context uses the same root registry with caching and bypass (${variable})`, { skip: !npmRuntime }, async (t) => {
    const { writeFile } = await import('node:fs/promises')
    const root = await scratch(t)
    const member = join(root, 'packages', 'member')
    await mkdir(member, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }))
    await writeFile(join(member, 'package.json'), JSON.stringify({ name: 'member', version: '1.0.0' }))
    const registry = await fixtureRegistry(t)
    await writeFile(join(root, '.npmrc'), `registry=${registry.url}\n`)
    await writeFile(join(member, '.npmrc'), 'registry=http://127.0.0.1:1/\n')
    await writeFile(join(root, 'userconfig'), '')
    const commands = await npmCommandDirectory(root, npmRuntime)
    const env = { ...registryEnv(root, registry.url), PATH: commands + delimiter + process.env.PATH, npm_config_userconfig: join(root, 'userconfig'), XDG_CACHE_HOME: join(root, 'catalog-cache') }
    delete env.npm_config_registry
    const bin = fileURLToPath(new URL('../bin/npm-dep-versions.js', import.meta.url))
    for (const extra of [[], ['--no-cache']]) {
      const result = await execute(process.execPath, [bin, 'fixture-package', '--project', member, '--format', 'json', ...extra], { env })
      assert.equal(JSON.parse(result.stdout).rows[0].version, '1.0.0')
    }
  })
}
