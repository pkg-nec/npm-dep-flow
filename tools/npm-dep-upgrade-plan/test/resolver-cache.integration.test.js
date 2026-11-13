import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveChoices } from '../src/resolver.js'
import { selectWithinRangeChoices } from '../src/coverage.js'

const runtimes = [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)
const isPackumentRequest = c => c.phase !== 'seed' && c.method === 'GET' && !c.path.startsWith('/tarballs/') && !c.path.startsWith('/-/') && c.path !== '/__checkpoint'

async function setup(t, npmCli) {
  const { createProject, scratchRoot } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
  const { shared } = await import('../../npm-dep-upgrade/test/e2e/fixtures/catalog.js')
  const f = await createProject(shared(true), { npmCli, installed: false }, t)
  const cacheHome = await mkdtemp(path.join(scratchRoot, 'packument-cache-'))
  t.after(() => rm(cacheHome, { recursive: true, force: true }))
  const row = { package: 'e2e-target', version: '6.0.9', advisories: [{ range: '<6.0.10' }], requirements: [
    { declaredRequirement: '6.0.9', directDependents: [{ location: 'node_modules/e2e-parent-b', requestedName: 'e2e-target', type: 'dependencies', targetLocation: 'node_modules/e2e-target' }] },
    { declaredRequirement: '^6.0.8', directDependents: [{ location: 'node_modules/e2e-parent-a', requestedName: 'e2e-target', type: 'dependencies', targetLocation: 'node_modules/e2e-target' }] },
  ] }
  const item = { ...row, targetLocation: 'node_modules/e2e-target' }
  const choices = selectWithinRangeChoices(row, 'node_modules/e2e-target', ['6.0.12'])
  const env = { ...f.env, XDG_CACHE_HOME: cacheHome }
  const packumentRequests = () => f.registry.calls.filter(isPackumentRequest).length
  const resolve = options => resolveChoices({ root: f.root }, item, choices, { env, packumentIdentity: 'fixture', ttlMs: 3600000, ...options })
  return { cacheHome, packumentRequests, resolve }
}

for (const npmCli of runtimes) test(`second resolve within the TTL makes no packument requests: ${npmCli}`, async (t) => {
  const f = await setup(t, npmCli)
  const first = await f.resolve()
  const afterFirst = f.packumentRequests()
  assert.ok(afterFirst > 0)
  const secondStart = Date.now()
  const second = await f.resolve()
  assert.equal(f.packumentRequests(), afterFirst)
  assert.deepEqual(second.choices, first.choices)
  assert.deepEqual(second.coverage, first.coverage)
  assert.ok(first.freshAt <= second.freshAt)
  assert.ok(second.freshAt < secondStart)
})

for (const npmCli of runtimes) test(`no-cache refetches and leaves no entries: ${npmCli}`, async (t) => {
  const f = await setup(t, npmCli)
  await f.resolve({ noCache: true })
  const afterFirst = f.packumentRequests()
  assert.ok(afterFirst > 0)
  await f.resolve({ noCache: true })
  assert.ok(f.packumentRequests() > afterFirst)
  await assert.rejects(access(path.join(f.cacheHome, 'npm-dep-upgrade-plan', 'packuments')), { code: 'ENOENT' })
})

for (const npmCli of runtimes) test(`expired entries are refetched: ${npmCli}`, async (t) => {
  const f = await setup(t, npmCli)
  await f.resolve({ ttlMs: 1 })
  const afterFirst = f.packumentRequests()
  await delay(5)
  await f.resolve({ ttlMs: 1 })
  assert.ok(f.packumentRequests() > afterFirst)
})

// A packument cached before a release can miss a version the catalog (cached separately) already offers.
async function dropCachedVersion(cacheHome, name, version) {
  const dir = path.join(cacheHome, 'npm-dep-upgrade-plan', 'packuments')
  for (const file of (await readdir(dir)).map(entry => path.join(dir, entry))) {
    const entry = JSON.parse(gunzipSync(await readFile(file)).toString())
    if (entry.packument.name !== name) continue
    delete entry.packument.versions[version]
    delete entry.packument.time?.[version]
    entry.checksum = createHash('sha256').update(JSON.stringify([entry.fetchedAt, entry.packument])).digest('hex')
    await writeFile(file, gzipSync(JSON.stringify(entry)))
  }
}

for (const npmCli of runtimes) test(`a cached packument missing a targeted version is refetched: ${npmCli}`, async (t) => {
  const f = await setup(t, npmCli)
  const first = await f.resolve()
  assert.deepEqual(first.choices.map(choice => choice.targetVersion), ['6.0.12'])
  await dropCachedVersion(f.cacheHome, 'e2e-target', '6.0.12')
  const afterFirst = f.packumentRequests()
  const second = await f.resolve()
  assert.ok(f.packumentRequests() > afterFirst)
  assert.deepEqual(second.choices, first.choices)
  assert.deepEqual(second.coverage, first.coverage)
})
