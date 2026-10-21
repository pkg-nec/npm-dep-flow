import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCatalogResponse } from '../src/model.js'
import { fixtureRegistry } from './helpers/registry.js'
import { execute, scratch, registryEnv } from './helpers/commands.js'

for (const variable of ['NPM_DEP_UPGRADE_E2E_NPM_CLI', 'NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI']) {
  const runtime = process.env[variable]
  if (process.env.NPM_DEP_VERSIONS_REQUIRE_RUNTIMES === '1' && (variable === 'NPM_DEP_UPGRADE_E2E_NPM_CLI' || process.platform !== 'win32')) assert.ok(runtime, `Missing required runtime: ${variable}`)
  test(`combined metadata with real ${variable}`, { skip: !runtime }, async (t) => {
    const root = await scratch(t)
    for (const time of [true, false]) {
      const registry = await fixtureRegistry(t, { time })
      const { stdout } = await execute(process.execPath, [runtime, 'view', 'fixture-package', 'versions', 'time', '--json'], { cwd: root, env: registryEnv(root, registry.url) })
      assert.deepEqual(normalizeCatalogResponse(JSON.parse(stdout)), [
        { version: '1.0.0', releasedAt: time ? '2026-01-01T00:00:00.000Z' : null },
        { version: '1.1.0-beta.1', releasedAt: null },
      ])
      assert.equal(registry.calls.length, 1)
    }
    const registry = await fixtureRegistry(t, { latest: false })
    const result = await execute(process.execPath, [runtime, 'view', 'fixture-package', 'versions', 'time', '--json'], { cwd: root, env: registryEnv(root, registry.url) })
    assert.throws(() => JSON.parse(result.stdout))
  })
}
