import assert from 'node:assert/strict'
import test from 'node:test'
import { consumerKey } from '../src/coverage.js'
import { MAX_ANCESTOR_LEVELS, findParentChoices } from '../src/ancestors.js'

const node = (name, version, location = `node_modules/${name}`) => ({ location, name, version })
const edge = (from, to, requestedName, spec, type = 'dependencies') => ({ from, to, requestedName, type, spec })
const asGraph = (nodes, edges) => ({ nodes: new Map([node('app', '1.0.0', ''), ...nodes].map(n => [n.location, n])), edges })
const consumer = (location, requestedName = 'a', type = 'dependencies') => ({ location, requestedName, type })
const row = { package: 'a', version: '1.2.3' }

// Fixture: root -> b -> a (b pins a), root -> g -> b, with optional extras.
function chain(extraNodes = [], extraEdges = []) {
  return asGraph(
    [node('a', '1.2.3'), node('b', '1.0.1'), node('g', '2.0.0'), ...extraNodes],
    [edge('', 'node_modules/g', 'g', '^2.0.0'), edge('node_modules/g', 'node_modules/b', 'b', '^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3'), ...extraEdges],
  )
}

function harness({ catalogs = {}, clears = () => false, releases = {} } = {}) {
  const catalogLookups = [], evaluations = []
  return {
    catalogLookups, evaluations,
    readCatalog: async (name) => {
      catalogLookups.push(name)
      const versions = catalogs[name] ?? []
      return { versions, releaseTimes: new Map(versions.map(version => [version, releases[`${name}@${version}`] ?? '2020-01-01T00:00:00.000Z'])) }
    },
    // evaluate(choices) -> keys of the original consumers the whole action set clears
    evaluate: async (choices) => {
      evaluations.push(choices.map(c => `${c.targetPackage}@${c.targetVersion}`))
      return new Set(clears(choices).map(consumerKey))
    },
  }
}

const find = (h, overrides = {}) => findParentChoices({ row, targetLocation: 'node_modules/a', unresolvedConsumers: [consumer('node_modules/b')], graph: chain(), readCatalog: h.readCatalog, evaluate: h.evaluate, ...overrides })
const clearsWhen = (predicate, consumers = [consumer('node_modules/b')]) => choices => (choices.some(predicate) ? consumers : [])

test('the ancestor depth bound is exactly two', () => assert.equal(MAX_ANCESTOR_LEVELS, 2))

test('stops after immediate-parent success: no grandparent candidate is looked up or evaluated', async () => {
  const h = harness({ catalogs: { b: ['1.0.1', '1.1.0', '1.2.0'], g: ['2.0.0', '3.0.0'] }, clears: clearsWhen(c => c.targetPackage === 'b' && c.targetVersion === '1.1.0') })
  const choices = await find(h)
  assert.equal(choices.length, 1)
  assert.equal(choices[0].targetPackage, 'b')
  assert.deepEqual(h.catalogLookups, ['b'])
  assert.ok(h.evaluations.every(set => set.every(entry => entry.startsWith('b@'))))
  assert.deepEqual(Object.keys(choices[0]).sort(), ['affectedConsumers', 'currentVersion', 'strategy', 'targetLocation', 'targetPackage', 'targetVersion'])
  assert.deepEqual(choices[0], { strategy: 'upgrade-via-parent-dependency', targetPackage: 'b', targetLocation: 'node_modules/b', currentVersion: '1.0.1', targetVersion: '1.1.0', affectedConsumers: [consumer('node_modules/b')] })
})

test('prefers the lowest suitable newer stable version, evaluating ascending', async () => {
  const h = harness({ catalogs: { b: ['1.2.0', '1.0.0', '1.1.0', '1.0.1', '1.3.0'] }, clears: clearsWhen(c => c.targetVersion === '1.2.0' || c.targetVersion === '1.3.0') })
  const choices = await find(h)
  assert.equal(choices[0].targetVersion, '1.2.0')
  assert.deepEqual(h.evaluations.map(set => set[0]), ['b@1.1.0', 'b@1.2.0'])
})

test('excludes candidates that violate another incoming requirement on the ancestor', async () => {
  const graph = chain([node('d', '1.0.0')], [edge('', 'node_modules/d', 'd', '^1.0.0'), edge('node_modules/d', 'node_modules/b', 'b', '~1.0.0')])
  const h = harness({ catalogs: { b: ['1.0.2', '1.1.0', '2.0.0'] }, clears: clearsWhen(c => c.targetPackage === 'b') })
  const choices = await find(h, { graph })
  assert.equal(choices[0].targetVersion, '1.0.2')
  assert.ok(h.evaluations.every(set => set[0] === 'b@1.0.2'))
})

test('falls back to the grandparent only when no immediate-parent candidate is suitable', async () => {
  const h = harness({ catalogs: { b: ['1.1.0', '1.2.0'], g: ['2.0.0', '2.1.0'] }, clears: clearsWhen(c => c.targetPackage === 'g' && c.targetVersion === '2.1.0') })
  const choices = await find(h)
  assert.deepEqual(choices.map(c => `${c.targetPackage}@${c.targetVersion}`), ['g@2.1.0'])
  assert.deepEqual(h.catalogLookups, ['b', 'g'])
  assert.equal(choices[0].targetLocation, 'node_modules/g')
  assert.deepEqual(choices[0].affectedConsumers, [consumer('node_modules/b')])
})

test('never evaluates a third ancestor level, even when it would be safe', async () => {
  const graph = chain([node('h', '3.0.0')], [edge('', 'node_modules/h', 'h', '^3.0.0'), edge('node_modules/h', 'node_modules/g', 'g', '^2.0.0')])
  const h = harness({ catalogs: { b: ['1.1.0'], g: ['2.1.0'], h: ['3.1.0'] }, clears: clearsWhen(c => c.targetPackage === 'h') })
  assert.deepEqual(await find(h, { graph }), [])
  assert.deepEqual(h.catalogLookups, ['b', 'g'])
})

test('the project root is not an upgradable package', async () => {
  const graph = asGraph([node('a', '1.2.3')], [edge('', 'node_modules/a', 'a', '1.2.3')])
  const h = harness({ clears: () => [consumer('')] })
  assert.deepEqual(await find(h, { graph, unresolvedConsumers: [consumer('')] }), [])
  assert.deepEqual(h.catalogLookups, [])
  const viaRoot = harness({ catalogs: { b: ['1.1.0'] }, clears: () => [] })
  assert.deepEqual(await find(viaRoot, { graph: chain() }), [])
  assert.ok(!viaRoot.catalogLookups.includes('app'))
})

test('independent branches are searched independently and ordered deterministically', async () => {
  const graph = asGraph(
    [node('a', '1.2.3'), node('b', '1.0.1'), node('d', '1.0.0')],
    [edge('', 'node_modules/b', 'b', '^1.0.0'), edge('', 'node_modules/d', 'd', '^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3'), edge('node_modules/d', 'node_modules/a', 'a', '1.2.3')],
  )
  const both = [consumer('node_modules/d'), consumer('node_modules/b')]
  const h = harness({
    catalogs: { b: ['1.1.0'], d: ['1.1.0'] },
    clears: choices => both.filter(c => choices.some(x => x.targetLocation === c.location)),
  })
  const choices = await find(h, { graph, unresolvedConsumers: both })
  assert.deepEqual(choices.map(c => c.targetPackage), ['b', 'd'])
  assert.deepEqual(choices.map(c => c.affectedConsumers.map(x => x.location)), [['node_modules/b'], ['node_modules/d']])
})

test('a branch left unresolved at level one does not stop another branch from succeeding', async () => {
  const graph = asGraph(
    [node('a', '1.2.3'), node('b', '1.0.1'), node('d', '1.0.0')],
    [edge('', 'node_modules/b', 'b', '^1.0.0'), edge('', 'node_modules/d', 'd', '^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3'), edge('node_modules/d', 'node_modules/a', 'a', '1.2.3')],
  )
  const both = [consumer('node_modules/b'), consumer('node_modules/d')]
  const h = harness({ catalogs: { b: ['1.1.0'], d: ['1.1.0'] }, clears: choices => (choices.some(c => c.targetPackage === 'd') ? [consumer('node_modules/d')] : []) })
  const choices = await find(h, { graph, unresolvedConsumers: both })
  assert.deepEqual(choices.map(c => c.targetPackage), ['d'])
})

test('a shared grandparent is one deduplicated action covering every branch it clears', async () => {
  const graph = asGraph(
    [node('a', '1.2.3'), node('b1', '1.0.0'), node('b2', '1.0.0'), node('g', '2.0.0')],
    [edge('', 'node_modules/g', 'g', '^2.0.0'), edge('node_modules/g', 'node_modules/b1', 'b1', '^1.0.0'), edge('node_modules/g', 'node_modules/b2', 'b2', '^1.0.0'),
      edge('node_modules/b1', 'node_modules/a', 'a', '1.2.3'), edge('node_modules/b2', 'node_modules/a', 'a', '1.2.3')],
  )
  const both = [consumer('node_modules/b1'), consumer('node_modules/b2')]
  const h = harness({ catalogs: { b1: [], b2: [], g: ['2.1.0'] }, clears: clearsWhen(c => c.targetPackage === 'g', both) })
  const choices = await find(h, { graph, unresolvedConsumers: both })
  assert.equal(choices.length, 1)
  assert.deepEqual(choices[0].affectedConsumers, both)
  assert.equal(h.catalogLookups.filter(name => name === 'g').length, 1)
})

test('visited sets keep cyclic graphs finite', async () => {
  const graph = chain([], [edge('node_modules/b', 'node_modules/g', 'g', '^2.0.0')])
  const h = harness({ catalogs: { b: ['1.1.0'], g: ['2.1.0'] }, clears: () => [] })
  assert.deepEqual(await find(h, { graph }), [])
})

test('honors alias requested names, and refuses specs it cannot evaluate', async () => {
  const aliased = asGraph(
    [node('a', '1.2.3'), node('b', '1.0.1')],
    [edge('', 'node_modules/b', 'my-b', 'npm:b@^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3')],
  )
  const h = harness({ catalogs: { b: ['1.1.0', '2.0.0'] }, clears: clearsWhen(c => c.targetPackage === 'b') })
  assert.equal((await find(h, { graph: aliased }))[0].targetVersion, '1.1.0')
  const git = asGraph(
    [node('a', '1.2.3'), node('b', '1.0.1')],
    [edge('', 'node_modules/b', 'b', 'git+https://example.test/b.git'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3')],
  )
  const gitHarness = harness({ catalogs: { b: ['1.1.0'] }, clears: clearsWhen(c => c.targetPackage === 'b') })
  assert.deepEqual(await find(gitHarness, { graph: git }), [])
  assert.deepEqual(gitHarness.evaluations, [])
})

test('only newer stable catalog versions are candidates', async () => {
  const h = harness({ catalogs: { b: ['0.9.0', '1.0.1', '1.1.0-beta.1', '1.1.0'] }, clears: clearsWhen(c => c.targetPackage === 'b') })
  const choices = await find(h)
  assert.equal(choices[0].targetVersion, '1.1.0')
  assert.deepEqual(h.evaluations, [['b@1.1.0']])
})

test('results do not depend on input ordering', async () => {
  const consumers = [consumer('node_modules/b'), consumer('node_modules/d')]
  const graph = asGraph(
    [node('a', '1.2.3'), node('b', '1.0.1'), node('d', '1.0.0')],
    [edge('', 'node_modules/b', 'b', '^1.0.0'), edge('', 'node_modules/d', 'd', '^1.0.0'), edge('node_modules/b', 'node_modules/a', 'a', '1.2.3'), edge('node_modules/d', 'node_modules/a', 'a', '1.2.3')],
  )
  const run = async (list, versions) => find(harness({ catalogs: { b: versions, d: versions }, clears: choices => consumers.filter(c => choices.some(x => x.targetLocation === c.location)) }), { graph, unresolvedConsumers: list })
  assert.deepEqual(await run(consumers, ['1.1.0', '1.2.0']), await run([...consumers].reverse(), ['1.2.0', '1.1.0']))
})

test('a failing catalog or evaluation is an error, not evidence of no solution', async () => {
  const h = harness()
  await assert.rejects(find(h, { readCatalog: async () => {
    throw new Error('catalog failed')
  } }), /catalog failed/)
  const failing = harness({ catalogs: { b: ['1.1.0'] } })
  await assert.rejects(find(failing, { evaluate: async () => {
    throw new Error('resolver failed')
  } }), /resolver failed/)
})

test('candidates younger than the release-age floor, or without a release time, are never evaluated', async () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z')
  const h = harness({
    catalogs: { b: ['1.1.0', '1.2.0', '1.3.0'] },
    releases: { 'b@1.1.0': '2026-10-24T00:00:00.000Z', 'b@1.2.0': '2026-10-10T00:00:00.000Z' },
    clears: clearsWhen(c => c.targetPackage === 'b'),
  })
  const noTime = { ...h, readCatalog: async () => ({ versions: ['1.1.0', '1.2.0', '1.3.0'], releaseTimes: new Map([['1.2.0', '2026-10-10T00:00:00.000Z'], ['1.3.0', 'not a date']]) }) }
  const choices = await find(h, { now })
  assert.equal(choices[0].targetVersion, '1.2.0')
  assert.deepEqual(h.evaluations, [['b@1.2.0']])
  const second = harness({ clears: clearsWhen(c => c.targetPackage === 'b') })
  const result = await find(second, { readCatalog: noTime.readCatalog, now })
  assert.equal(result[0].targetVersion, '1.2.0')
  assert.deepEqual(second.evaluations, [['b@1.2.0']])
})

test('the configured release-age policy, not a fixed number, decides which releases are old enough', async () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z')
  const releases = { 'b@1.1.0': '2026-09-20T00:00:00.000Z', 'b@1.2.0': '2026-08-20T00:00:00.000Z', 'b@1.3.0': '2026-07-20T00:00:00.000Z' }
  const clears = clearsWhen(c => c.targetPackage === 'b')
  const strict = harness({ catalogs: { b: ['1.1.0', '1.2.0', '1.3.0'] }, releases, clears })
  assert.equal((await find(strict, { now, policy: { minAgeDays: 60, cutoffMs: null } }))[0].targetVersion, '1.2.0')
  const bounded = harness({ catalogs: { b: ['1.1.0', '1.2.0', '1.3.0'] }, releases, clears })
  assert.equal((await find(bounded, { now, policy: { minAgeDays: 7, cutoffMs: Date.parse('2026-08-01T00:00:00.000Z') } }))[0].targetVersion, '1.3.0')
  const none = harness({ catalogs: { b: ['1.1.0', '1.2.0', '1.3.0'] }, releases, clears })
  assert.deepEqual(await find(none, { now, policy: { minAgeDays: 365, cutoffMs: null } }), [])
  assert.deepEqual(none.evaluations, [])
})
