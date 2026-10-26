import assert from 'node:assert/strict'
import test from 'node:test'
import semver from 'semver'
import { orderChoices, parentRanges, selectParentRelease } from '../src/parents.js'

const node = (location, name, version) => ({ location, name, version })
const edge = (from, to, requestedName, rawSpec) => ({ from, to, requestedName, type: 'dependencies', rawSpec, effectiveSpec: rawSpec, valid: true })
const graph = (nodes, edges) => ({ nodes: new Map(nodes.map(n => [n.location, n])), edges })
const consumer = location => ({ location, requestedName: 'a', type: 'dependencies' })
const parent = (name, version, current, location = `node_modules/${name}`, consumers = [consumer('node_modules/b')]) => ({ strategy: 'upgrade-via-parent-dependency', targetPackage: name, targetLocation: location, currentVersion: current, targetVersion: version, affectedConsumers: consumers })
const withinRange = { strategy: 'update-within-declared-range', targetPackage: 'a', targetLocation: 'node_modules/a', currentVersion: '1.2.3', targetVersion: '1.2.5', affectedConsumers: [consumer('node_modules/c')] }

const g = graph(
  [node('', 'app', '1.0.0'), node('node_modules/a', 'a', '1.2.3'), node('node_modules/b', 'b', '1.0.1'), node('node_modules/c', 'c', '1.0.0'), node('node_modules/g', 'g', '1.0.0'), node('node_modules/h', 'h', '1.0.0')],
  [edge('', 'node_modules/g', 'g', '^1.0.0'), edge('node_modules/g', 'node_modules/b', 'b', '^1.0.0'), edge('', 'node_modules/c', 'c', '^1.0.0'), edge('', 'node_modules/h', 'h', '^1.0.0'),
    edge('node_modules/b', 'node_modules/a', 'a', '1.2.3'), edge('node_modules/c', 'node_modules/a', 'a', '^1.2.0'), edge('node_modules/h', 'node_modules/b', 'b', '~1.0.0')],
)
const evidence = { graph: g, incoming: g.edges.filter(e => e.to === 'node_modules/a') }

test('actions run parents first by ancestor level, then location, name and version; within-range actions follow', () => {
  const grand = parent('g', '1.1.0', '1.0.0', 'node_modules/g')
  const immediate = parent('b', '1.1.0', '1.0.1')
  const ordered = orderChoices({ choices: [withinRange, grand, immediate] }, evidence)
  assert.deepEqual(ordered.map(entry => entry.choice.targetPackage), ['b', 'g', 'a'])
  assert.deepEqual(ordered.map(entry => entry.level), [1, 2, 0])
  const same = orderChoices({ choices: [parent('h', '1.1.0', '1.0.0', 'node_modules/h', [consumer('node_modules/b')]), grand] }, evidence)
  assert.deepEqual(same.map(entry => entry.choice.targetPackage), ['g', 'h'])
})

test('a parent choice outside two ancestor levels, or for a changed installation, is rejected against fresh evidence', () => {
  assert.throws(() => orderChoices({ choices: [parent('c', '1.1.0', '1.0.0', 'node_modules/c', [consumer('node_modules/b')])] }, evidence), /outside two ancestor levels/i)
  assert.throws(() => orderChoices({ choices: [parent('b', '1.1.0', '9.9.9')] }, evidence), /stale|changed/i)
  assert.throws(() => orderChoices({ choices: [parent('b', '1.1.0', '1.0.1', 'node_modules/missing')] }, evidence), /stale|changed/i)
  assert.throws(() => orderChoices({ choices: [parent('b', '1.1.0', '1.0.1', 'node_modules/b', [consumer('node_modules/not-a-consumer')])] }, evidence), /consumer/i)
})

test('a parent choice must be a deeper ancestor of every covered consumer than the project root', () => {
  const rootChild = graph([node('', 'app', '1.0.0'), node('node_modules/a', 'a', '1.2.3')], [edge('', 'node_modules/a', 'a', '1.2.3')])
  assert.throws(() => orderChoices({ choices: [parent('a', '1.2.5', '1.2.3', 'node_modules/a', [consumer('')])] }, { graph: rootChild, incoming: rootChild.edges }), /outside two ancestor levels|stale|changed/i)
})

test('every incoming declaration on the ancestor constrains it, and unusable specs are refused', () => {
  assert.deepEqual(parentRanges(parent('b', '1.1.0', '1.0.1'), g), ['^1.0.0', '~1.0.0'].map(range => semver.validRange(range)))
  const aliased = graph([node('', 'app', '1.0.0'), node('node_modules/b', 'b', '1.0.1')], [edge('', 'node_modules/b', 'my-b', 'npm:b@^1.0.0')])
  assert.deepEqual(parentRanges(parent('b', '1.1.0', '1.0.1'), aliased), [semver.validRange('^1.0.0')])
  const git = graph([node('', 'app', '1.0.0'), node('node_modules/b', 'b', '1.0.1')], [edge('', 'node_modules/b', 'b', 'git+https://example.test/b.git')])
  assert.throws(() => parentRanges(parent('b', '1.1.0', '1.0.1'), git), /requirement/i)
})

const catalog = overrides => ({ versions: ['1.0.1', '1.1.0', '1.2.0'], releaseTimes: new Map([['1.1.0', '2026-09-01T00:00:00.000Z'], ['1.2.0', '2026-10-19T00:00:00.000Z']]), minAgeDays: 7, cutoffMs: undefined, ...overrides })
const now = Date.parse('2026-10-21T00:00:00.000Z')

test('the planned parent release is used only while it is still eligible', () => {
  assert.deepEqual(selectParentRelease(parent('b', '1.1.0', '1.0.1'), ['^1.0.0'], catalog(), [], now), { version: '1.1.0', releasedAt: '2026-09-01T00:00:00.000Z' })
  for (const [label, choice, ranges, cat, advisories, pattern] of [
    ['too young', parent('b', '1.2.0', '1.0.1'), ['^1.0.0'], catalog(), [], /age/i],
    ['missing release time', parent('b', '1.1.0', '1.0.1'), ['^1.0.0'], catalog({ releaseTimes: new Map() }), [], /age|release/i],
    ['not in the catalog', parent('b', '1.5.0', '1.0.1'), ['^1.0.0'], catalog(), [], /catalog|eligible/i],
    ['outside an incoming range', parent('b', '1.1.0', '1.0.1'), ['~1.0.0'], catalog(), [], /requirement|range/i],
    ['now vulnerable', parent('b', '1.1.0', '1.0.1'), ['^1.0.0'], catalog(), [{ id: 1, range: '>=1.1.0 <1.2.0' }], /vulnerable|advisory/i],
    ['after the configured cutoff', parent('b', '1.1.0', '1.0.1'), ['^1.0.0'], catalog({ cutoffMs: Date.parse('2026-08-01T00:00:00.000Z') }), [], /age/i],
  ]) assert.throws(() => selectParentRelease(choice, ranges, cat, advisories, now), pattern, label)
})

test('a planned release that is no longer eligible falls forward to the lowest newer eligible release', () => {
  const rich = catalog({ versions: ['1.0.1', '1.1.0', '1.2.0', '1.3.0'], releaseTimes: new Map([['1.1.0', '2026-09-01T00:00:00.000Z'], ['1.2.0', '2026-09-02T00:00:00.000Z'], ['1.3.0', '2026-10-20T00:00:00.000Z']]) })
  const vulnerable = [{ id: 1, range: '>=1.1.0 <1.2.0' }]
  assert.deepEqual(selectParentRelease(parent('b', '1.1.0', '1.0.1'), ['^1.0.0'], rich, vulnerable, now), { version: '1.2.0', releasedAt: '2026-09-02T00:00:00.000Z' })
  assert.throws(() => selectParentRelease(parent('b', '1.1.0', '1.0.1'), ['^1.0.0'], rich, [{ id: 1, range: '>=1.1.0 <1.3.0' }], now), /vulnerable|age/i)
  assert.throws(() => selectParentRelease(parent('b', '1.1.0', '1.0.1'), ['>=1.0.0 <1.2.0'], rich, vulnerable, now), /vulnerable|requirement|eligible/i)
})
