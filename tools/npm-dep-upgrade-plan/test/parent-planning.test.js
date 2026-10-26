import assert from 'node:assert/strict'
import test from 'node:test'
import { consumerKey } from '../src/coverage.js'
import { planParentChoices } from '../src/parent-planning.js'

const dependent = (name, version, location, requestedName = 'a') => ({ name, version, location, targetLocation: 'node_modules/a', type: 'dependencies', requestedName })
const consumer = (location, requestedName = 'a') => ({ location, requestedName, type: 'dependencies' })
const row = {
  package: 'a', version: '1.2.3', severity: 'high', advisories: [{ range: '<1.2.5' }],
  requirements: [
    { declaredRequirement: '1.2.3', directDependents: [dependent('b', '1.0.1', 'node_modules/b'), dependent('d', '1.0.0', 'node_modules/d')] },
    { declaredRequirement: '^1.2.0', directDependents: [dependent('c', '1.0.0', 'node_modules/c')] },
  ],
}
const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'a', targetLocation: 'node_modules/a', currentVersion: '1.2.3', targetVersion: '1.2.5', affectedConsumers: [consumer('node_modules/c')] }
const parent = (name, version, location = `node_modules/${name}`, consumers = [consumer(`node_modules/${name}`)]) => ({ strategy: 'upgrade-via-parent-dependency', targetPackage: name, targetLocation: location, currentVersion: '1.0.1', targetVersion: version, affectedConsumers: consumers })
const finding = (choices = [withinRange], resolution = 'partial') => ({ package: 'a', version: '1.2.3', targetLocation: 'node_modules/a', resolution, choices: structuredClone(choices) })
const base = { project: { root: '/project' }, options: { noCache: false, ttlMs: 3600000 }, controls: { noCache: false } }
const iso = days => new Date(Date.now() - days * 86400000).toISOString()

function adapters(overrides = {}) {
  const calls = { upstream: [], catalogs: [], resolves: [], find: [] }
  const found = overrides.found ?? [parent('b', '1.1.0'), parent('d', '1.1.0')]
  return {
    calls,
    adapters: {
      readUpstream: async (root, target, parents, controls) => {
        calls.upstream.push({ root, target, parents, controls })
        return { nodes: new Map(), edges: [] }
      },
      readCatalog: async (name) => {
        calls.catalogs.push(name)
        return { versions: ['1.1.0'], releaseTimes: new Map([['1.1.0', iso(30)]]), fetchedAt: iso(0.01) }
      },
      findParentChoices: async (request) => {
        calls.find.push(request)
        for (const candidate of found) {
          await request.readCatalog(candidate.targetPackage)
          await request.evaluate([...request.accepted, candidate])
        }
        return found
      },
      resolveChoices: async (project, item, choices, options) => {
        calls.resolves.push({ item, choices, options })
        const parents = choices.filter(c => c.strategy === 'upgrade-via-parent-dependency')
        const cleared = [consumer('node_modules/c'), ...parents.flatMap(p => p.affectedConsumers)]
        return { choices, coverage: { resolution: cleared.length === 3 ? 'complete' : 'partial', clearedConsumers: cleared }, freshAt: Date.now() }
      },
      ...overrides.adapters,
    },
  }
}

test('adds parent choices for branches within-range cannot cover and resolves the whole set', async () => {
  const f = finding()
  const { adapters: a, calls } = adapters()
  const result = await planParentChoices({ ...base, finding: f, row, adapters: a })
  assert.ok(Number.isFinite(result.freshAt))
  assert.deepEqual(calls.upstream[0].target, { package: 'a', version: '1.2.3' })
  assert.deepEqual(calls.upstream[0].parents, [{ name: 'b', version: '1.0.1' }, { name: 'd', version: '1.0.0' }])
  assert.deepEqual(calls.find[0].unresolvedConsumers, [consumer('node_modules/b'), consumer('node_modules/d')])
  assert.deepEqual(calls.find[0].accepted, [withinRange])
  assert.deepEqual(f.choices.map(c => c.strategy), ['update-within-declared-range', 'upgrade-via-parent-dependency', 'upgrade-via-parent-dependency'])
  assert.deepEqual(f.choices.slice(1).map(c => c.targetPackage), ['b', 'd'])
  assert.equal(f.resolution, 'complete')
})

test('parent actions are resolved before within-range actions and release times reach the resolver', async () => {
  const { adapters: a, calls } = adapters()
  await planParentChoices({ ...base, finding: finding(), row, adapters: a })
  const last = calls.resolves.at(-1)
  assert.deepEqual(last.choices.map(c => c.strategy), ['upgrade-via-parent-dependency', 'upgrade-via-parent-dependency', 'update-within-declared-range'])
  assert.ok(Object.hasOwn(last.options.releaseTimes, 'b@1.1.0'))
  assert.equal(last.item.targetLocation, 'node_modules/a')
  assert.equal(last.options.ttlMs, 3600000)
})

test('forwards cache controls to the public paths query', async () => {
  const { adapters: a, calls } = adapters()
  await planParentChoices({ ...base, controls: { noCache: true, clearCache: true }, finding: finding(), row, adapters: a })
  assert.deepEqual(calls.upstream[0].controls, { noCache: true, clearCache: true })
})

test('does nothing when every unresolved consumer is the project root or none remain', async () => {
  const rootOnly = { ...row, requirements: [{ declaredRequirement: '^1', directDependents: [dependent('app', '1.0.0', '')] }] }
  const { adapters: a, calls } = adapters()
  const f = finding([], 'none')
  const result = await planParentChoices({ ...base, finding: f, row: rootOnly, adapters: a })
  assert.equal(result.freshAt, Infinity)
  assert.deepEqual(calls.upstream, [])
  const complete = finding([{ ...withinRange, affectedConsumers: [consumer('node_modules/b'), consumer('node_modules/d'), consumer('node_modules/c')] }], 'complete')
  await planParentChoices({ ...base, finding: complete, row, adapters: a })
  assert.deepEqual(calls.upstream, [])
})

test('a candidate the resolver drops, or one that makes an earlier parent choice drop, is not suitable', async () => {
  const dropped = []
  const { adapters: a, calls } = adapters({
    found: [parent('b', '1.1.0')],
    adapters: {
      resolveChoices: async (project, item, choices) => {
        dropped.push(choices.length)
        return { choices: choices.filter(c => c.strategy !== 'upgrade-via-parent-dependency'), coverage: { resolution: 'partial', clearedConsumers: [consumer('node_modules/c'), consumer('node_modules/b')] }, freshAt: Date.now() }
      },
    },
  })
  const f = finding()
  let verdict
  a.findParentChoices = async (request) => {
    verdict = await request.evaluate([...request.accepted, parent('b', '1.1.0')])
    return []
  }
  await planParentChoices({ ...base, finding: f, row, adapters: a })
  assert.equal(verdict.size, 0)
  assert.deepEqual(f.choices, [withinRange])
  assert.equal(f.resolution, 'partial')
  assert.ok(dropped.length >= 1 && calls)
})

test('the evaluator reports the consumers the resolved set clears', async () => {
  const { adapters: a } = adapters()
  let verdict
  a.findParentChoices = async (request) => {
    verdict = await request.evaluate([...request.accepted, parent('b', '1.1.0')])
    return []
  }
  await planParentChoices({ ...base, finding: finding(), row, adapters: a })
  assert.deepEqual([...verdict].sort(), [consumerKey(consumer('node_modules/b')), consumerKey(consumer('node_modules/c'))].sort())
})

test('the oldest ancestor catalog bounds the returned freshness even when nothing is found', async () => {
  const old = iso(0.5)
  const { adapters: a } = adapters({ adapters: { readCatalog: async () => ({ versions: ['1.1.0'], releaseTimes: new Map(), fetchedAt: old }) } })
  a.findParentChoices = async (request) => {
    await request.readCatalog('b')
    return []
  }
  const result = await planParentChoices({ ...base, finding: finding(), row, adapters: a })
  assert.equal(result.freshAt, Date.parse(old))
})

test('discovery and resolver failures are errors, not evidence of no solution', async () => {
  const failing = adapters({ adapters: { readUpstream: async () => {
    throw new Error('npm-dep-paths failed')
  } } })
  await assert.rejects(planParentChoices({ ...base, finding: finding(), row, adapters: failing.adapters }), /npm-dep-paths failed/)
  const resolver = adapters({ adapters: { resolveChoices: async () => {
    throw new Error('Dependency resolver failed')
  } } })
  await assert.rejects(planParentChoices({ ...base, finding: finding(), row, adapters: resolver.adapters }), /resolver failed/)
})

test('parent actions are resolved in the executor order: ancestor level first, then location', async () => {
  const twoLevels = {
    ...row,
    requirements: [{ declaredRequirement: '1.2.3', directDependents: [dependent('z-parent', '1.0.1', 'node_modules/z-parent'), dependent('b2', '1.0.0', 'node_modules/b2')] }],
  }
  const level1 = parent('z-parent', '1.1.0', 'node_modules/z-parent', [consumer('node_modules/z-parent')])
  const level2 = parent('a-grand', '2.1.0', 'node_modules/a-grand', [consumer('node_modules/b2')])
  const { adapters: a, calls } = adapters({ found: [level2, level1] })
  const f = finding([], 'none')
  await planParentChoices({ ...base, finding: f, row: twoLevels, adapters: a })
  assert.deepEqual(calls.resolves.at(-1).choices.map(c => c.targetPackage), ['z-parent', 'a-grand'])
  for (const call of calls.resolves) {
    const names = call.choices.map(c => c.targetPackage)
    assert.ok(names.indexOf('z-parent') < names.indexOf('a-grand') || !names.includes('a-grand') || !names.includes('z-parent'))
  }
})
