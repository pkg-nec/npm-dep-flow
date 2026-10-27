import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { consumerKey } from '../src/coverage.js'
import { planToolchainChoices } from '../src/toolchain-planning.js'

const CLI = 'node_modules/@angular/cli'
const BUILD = 'node_modules/@angular/build'
const CORE = 'node_modules/@angular-devkit/core'
const dependent = (name, version, location, requestedName = 'a', targetLocation = 'node_modules/a') => ({ name, version, location, targetLocation, type: 'dependencies', requestedName })
const consumer = (location, requestedName = 'a', type = 'dependencies') => ({ location, requestedName, type })
const row = {
  package: 'a', version: '1.2.3', severity: 'high', advisories: [{ range: '<1.2.5' }],
  requirements: [
    { declaredRequirement: '1.2.3', directDependents: [dependent('@angular/build', '21.2.26', BUILD), dependent('@angular-devkit/core', '21.2.26', CORE), dependent('x', '1.0.0', 'node_modules/x')] },
    { declaredRequirement: '^1.2.0', directDependents: [dependent('c', '1.0.0', 'node_modules/c')] },
  ],
}
const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'a', targetLocation: 'node_modules/a', currentVersion: '1.2.3', targetVersion: '1.2.5', affectedConsumers: [consumer('node_modules/c')] }
const parentChoice = { strategy: 'upgrade-via-parent-dependency', targetPackage: 'x', targetLocation: 'node_modules/x', currentVersion: '1.0.0', targetVersion: '1.1.0', affectedConsumers: [consumer('node_modules/x')] }
const finding = (choices = [withinRange], resolution = 'partial') => ({ package: 'a', version: '1.2.3', targetLocation: 'node_modules/a', resolution, choices: structuredClone(choices) })
const manifest = { name: 'app', version: '1.0.0', devDependencies: { '@angular/cli': '21.2.26', '@angular/build': '21.2.26' } }
const lock = { lockfileVersion: 3, packages: { '': { name: 'app' }, [CLI]: { version: '21.2.26' }, [BUILD]: { version: '21.2.26' }, [CORE]: { version: '21.2.26' } } }
const project = (m = manifest, l = lock) => ({ root: '/project', manifestBytes: Buffer.from(JSON.stringify(m)), lockBytes: Buffer.from(JSON.stringify(l)) })
const base = { options: { noCache: false, ttlMs: 3600000 }, controls: { noCache: false } }
const iso = days => new Date(Date.now() - days * 86400000).toISOString()
const upstream = {
  nodes: new Map([['', { location: '', name: 'app', version: '1.0.0' }], [CLI, { location: CLI, name: '@angular/cli', version: '21.2.26' }], [BUILD, { location: BUILD, name: '@angular/build', version: '21.2.26' }], [CORE, { location: CORE, name: '@angular-devkit/core', version: '21.2.26' }], ['node_modules/x', { location: 'node_modules/x', name: 'x', version: '1.0.0' }]]),
  edges: [{ from: '', to: CLI }, { from: '', to: BUILD }, { from: CLI, to: CORE }, { from: '', to: 'node_modules/x' }],
}
const catalogFetchedAt = iso(0.02)

// The resolver clears the toolchain branches from 21.2.28 on; older candidates leave them affected.
function adapters(overrides = {}) {
  const calls = { upstream: [], catalogs: [], resolves: [] }
  const clearsAt = 'clearsAt' in overrides ? overrides.clearsAt : '21.2.28'
  return {
    calls,
    adapters: {
      readUpstream: async (root, target, parents, controls) => {
        calls.upstream.push({ root, target, parents, controls })
        return upstream
      },
      readCatalog: async (name) => {
        calls.catalogs.push(name)
        return { versions: ['21.2.25', '21.2.26', '21.2.27', '21.2.28', '21.3.0', '21.3.0-rc.0', '22.0.0'], releaseTimes: new Map([['21.2.27', iso(30)], ['21.2.28', iso(1)]]), fetchedAt: catalogFetchedAt }
      },
      resolveChoices: async (p, item, choices, options) => {
        calls.resolves.push({ item, choices: structuredClone(choices), options })
        const toolchain = choices.find(c => c.strategy === 'upgrade-angular-toolchain')
        const clears = toolchain && clearsAt && semver.gte(toolchain.targetVersion, clearsAt)
        const cleared = [...choices.filter(c => c.strategy !== 'upgrade-angular-toolchain').flatMap(c => c.affectedConsumers), ...(clears ? [consumer(BUILD), consumer(CORE)] : [])]
        const all = [consumer(BUILD), consumer(CORE), consumer('node_modules/x'), consumer('node_modules/c')]
        const remaining = all.filter(c => !cleared.some(d => consumerKey(d) === consumerKey(c)))
        return { choices, graph: { nodes: [], edges: [] }, coverage: { resolution: remaining.length ? 'partial' : 'complete', clearedConsumers: cleared, remainingConsumers: remaining }, freshAt: Date.now() }
      },
      ...overrides.adapters,
    },
  }
}

test('picks the lowest clearing candidate with no release-age filter and resolves it first', async () => {
  const f = finding()
  const { adapters: a, calls } = adapters()
  await planToolchainChoices({ ...base, project: project(), finding: f, row, adapters: a })
  assert.deepEqual(calls.catalogs, ['@angular/cli'])
  assert.deepEqual(calls.upstream[0].target, { package: 'a', version: '1.2.3' })
  for (const call of calls.resolves) assert.equal(call.choices[0].strategy, 'upgrade-angular-toolchain')
  assert.deepEqual(calls.resolves.map(call => call.choices[0].targetVersion), ['21.2.27', '21.2.28'])
  assert.equal(calls.resolves[0].item.targetLocation, 'node_modules/a')
  assert.deepEqual(f.choices[0], {
    strategy: 'upgrade-angular-toolchain', targetPackage: '@angular/cli', targetLocation: CLI, currentVersion: '21.2.26', targetVersion: '21.2.28',
    affectedConsumers: [consumer(BUILD), consumer(CORE)],
  })
  assert.equal(f.resolution, 'partial')
})

test('keeps existing choices and orders the toolchain first, then parents, then within-range', async () => {
  const f = finding([withinRange, parentChoice])
  const { adapters: a, calls } = adapters()
  await planToolchainChoices({ ...base, project: project(), finding: f, row, adapters: a })
  assert.deepEqual(f.choices.map(c => c.strategy), ['upgrade-angular-toolchain', 'upgrade-via-parent-dependency', 'update-within-declared-range'])
  assert.deepEqual(calls.resolves.at(-1).choices.map(c => c.strategy), ['upgrade-angular-toolchain', 'upgrade-via-parent-dependency', 'update-within-declared-range'])
  assert.equal(f.resolution, 'complete')
})

test('a candidate that makes an existing choice drop is not suitable', async () => {
  const f = finding()
  const { adapters: a } = adapters()
  const inner = a.resolveChoices
  a.resolveChoices = async (...args) => {
    const result = await inner(...args)
    return { ...result, choices: result.choices.filter(c => c.strategy !== 'update-within-declared-range') }
  }
  await planToolchainChoices({ ...base, project: project(), finding: f, row, adapters: a })
  assert.deepEqual(f.choices, [withinRange])
  assert.equal(f.resolution, 'partial')
})

test('leaves the finding untouched when no candidate clears a branch', async () => {
  const f = finding()
  const { adapters: a, calls } = adapters({ clearsAt: null })
  await planToolchainChoices({ ...base, project: project(), finding: f, row, adapters: a })
  assert.deepEqual(calls.resolves.map(call => call.choices[0].targetVersion), ['21.2.27', '21.2.28', '21.3.0'])
  assert.deepEqual(f, finding())
})

test('skips projects without an Angular toolchain and findings already complete', async () => {
  const { adapters: a, calls } = adapters()
  const noCli = { ...manifest, devDependencies: { '@angular/build': '21.2.26' } }
  const f = finding()
  assert.deepEqual(await planToolchainChoices({ ...base, project: project(noCli), finding: f, row, adapters: a }), { freshAt: Infinity })
  assert.deepEqual(f, finding())
  const mismatched = { ...lock, packages: { ...lock.packages, [BUILD]: { version: '21.2.25' } } }
  await planToolchainChoices({ ...base, project: project(manifest, mismatched), finding: f, row, adapters: a })
  await planToolchainChoices({ ...base, project: { root: '/project' }, finding: f, row, adapters: a })
  const complete = finding([{ ...withinRange, affectedConsumers: [consumer(BUILD), consumer(CORE), consumer('node_modules/x'), consumer('node_modules/c')] }], 'complete')
  assert.deepEqual(await planToolchainChoices({ ...base, project: project(), finding: complete, row, adapters: a }), { freshAt: Infinity })
  assert.deepEqual(calls, { upstream: [], catalogs: [], resolves: [] })
})

test('consumers outside two levels below a member are not tried', async () => {
  const outside = { ...row, requirements: [{ declaredRequirement: '1.2.3', directDependents: [dependent('x', '1.0.0', 'node_modules/x')] }] }
  const { adapters: a, calls } = adapters()
  const f = finding([], 'none')
  await planToolchainChoices({ ...base, project: project(), finding: f, row: outside, adapters: a })
  assert.equal(calls.upstream.length, 1)
  assert.deepEqual(calls.resolves, [])
  assert.deepEqual(f.choices, [])
})

test('a vulnerable member is cleared through its root declaration without a paths query', async () => {
  const member = { package: '@angular/build', version: '21.2.26', severity: 'high', advisories: [{ range: '<21.2.27' }], requirements: [{ declaredRequirement: '21.2.26', directDependents: [dependent('app', '1.0.0', '', '@angular/build', BUILD)] }] }
  member.requirements[0].directDependents[0].type = 'devDependencies'
  const root = consumer('', '@angular/build', 'devDependencies')
  const calls = { upstream: 0, resolves: [] }
  const a = {
    readUpstream: async () => {
      calls.upstream += 1
      return upstream
    },
    readCatalog: async () => ({ versions: ['21.2.27'], releaseTimes: new Map(), fetchedAt: catalogFetchedAt }),
    resolveChoices: async (p, item, choices) => {
      calls.resolves.push(choices)
      return { choices, graph: { nodes: [], edges: [] }, coverage: { resolution: 'complete', clearedConsumers: [root], remainingConsumers: [] }, freshAt: Date.now() }
    },
  }
  const f = { package: '@angular/build', version: '21.2.26', targetLocation: BUILD, resolution: 'none', choices: [] }
  await planToolchainChoices({ ...base, project: project(), finding: f, row: member, adapters: a })
  assert.equal(calls.upstream, 0)
  assert.deepEqual(f.choices, [{ strategy: 'upgrade-angular-toolchain', targetPackage: '@angular/cli', targetLocation: CLI, currentVersion: '21.2.26', targetVersion: '21.2.27', affectedConsumers: [root] }])
  assert.equal(f.resolution, 'complete')
})

test('a root declaration of a non-member package is not in toolchain scope', async () => {
  const direct = { ...row, requirements: [{ declaredRequirement: '1.2.3', directDependents: [dependent('app', '1.0.0', '')] }] }
  const { adapters: a, calls } = adapters()
  await planToolchainChoices({ ...base, project: project(), finding: finding([], 'none'), row: direct, adapters: a })
  assert.deepEqual(calls.resolves, [])
})

test('returns the @angular/cli catalog freshness and forwards cache controls to paths', async () => {
  const { adapters: a, calls } = adapters()
  const result = await planToolchainChoices({ ...base, controls: { noCache: true, clearCache: true }, project: project(), finding: finding(), row, adapters: a })
  assert.equal(result.freshAt, Date.parse(catalogFetchedAt))
  assert.deepEqual(calls.upstream[0].controls, { noCache: true, clearCache: true })
  const none = adapters({ clearsAt: null })
  assert.equal((await planToolchainChoices({ ...base, project: project(), finding: finding(), row, adapters: none.adapters })).freshAt, Date.parse(catalogFetchedAt))
})
