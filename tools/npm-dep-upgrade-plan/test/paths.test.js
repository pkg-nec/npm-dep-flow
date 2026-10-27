import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { readUpstream } from '../src/paths.js'

const target = { package: 'a', version: '1.2.3' }
const dependent = (name, version, location) => ({ name, version, location, targetLocation: 'node_modules/a', type: 'dependencies', requestedName: 'a' })

function response(parent, { nodes, edges, dependents } = {}) {
  const [name, version] = [parent.slice(0, parent.lastIndexOf('@')), parent.slice(parent.lastIndexOf('@') + 1)]
  return {
    schemaVersion: 2,
    project: { name: 'app', version: '1.0.0' },
    selector: 'a@1.2.3',
    result: { package: 'a', version: '1.2.3', requirements: [{ declaredRequirement: '1.2.3', directDependents: dependents ?? [dependent(name, version, `node_modules/${name}`)] }] },
    upstream: {
      selectedDependent: parent, rootLocation: '', selectedLocations: [`node_modules/${name}`], targetLocations: ['node_modules/a'], topLevelLocations: [`node_modules/${name}`],
      nodes: nodes ?? [{ location: '', name: 'app', version: '1.0.0' }, { location: 'node_modules/a', name: 'a', version: '1.2.3' }, { location: `node_modules/${name}`, name, version }],
      edges: edges ?? [
        { from: '', to: `node_modules/${name}`, requestedName: name, type: 'dependencies', spec: '^1.0.0' },
        { from: `node_modules/${name}`, to: 'node_modules/a', requestedName: 'a', type: 'dependencies', spec: '1.2.3' },
      ],
    },
  }
}
const runner = (responses, calls = []) => async (command, args, cwd, spawnImpl, platform) => {
  calls.push({ command, args, cwd, spawnImpl, platform })
  const next = responses.shift()
  return typeof next === 'string' ? { code: 0, stdout: next, stderr: '' } : next.code !== undefined ? next : { code: 0, stdout: JSON.stringify(next), stderr: '' }
}

test('runs one public paths query per distinct immediate parent with forwarded controls', async () => {
  const calls = []
  await readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }, { name: 'c', version: '1.0.0' }, { name: 'b', version: '1.0.1' }], { run: runner([response('b@1.0.1'), response('c@1.0.0')], calls) })
  assert.deepEqual(calls.map(call => call.args), [
    ['.', 'a@1.2.3', '--upstream-of', 'b@1.0.1', '--format', 'json'],
    ['.', 'a@1.2.3', '--upstream-of', 'c@1.0.0', '--format', 'json'],
  ])
  assert.ok(calls.every(call => call.command === 'npm-dep-paths' && call.cwd === '/project'))
  const controlled = []
  await readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { noCache: true, clearCache: true, run: runner([response('b@1.0.1')], controlled) })
  assert.deepEqual(controlled[0].args.slice(-2), ['--no-cache', '--clear-cache'])
  const clearOnly = []
  await readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { clearCache: true, run: runner([response('b@1.0.1')], clearOnly) })
  assert.deepEqual(clearOnly[0].args.slice(-1), ['--clear-cache'])
})

test('uses the same argv through the Windows command shim', async () => {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify(response('b@1.0.1')))
      child.stderr.end('')
      child.emit('close', 0)
    })
    return child
  }
  await readUpstream('C:\\app', target, [{ name: 'b', version: '1.0.1' }], { noCache: true, spawnImpl, platform: 'win32' })
  assert.equal(calls[0].command, 'npm-dep-paths.cmd . a@1.2.3 --upstream-of b@1.0.1 --format json --no-cache')
  assert.equal(calls[0].options.shell, true)
})

test('merges parent graphs, deduplicating shared nodes and edges', async () => {
  const shared = { location: 'node_modules/g', name: 'g', version: '2.0.0' }
  const b = response('b@1.0.1', {
    nodes: [{ location: '', name: 'app', version: '1.0.0' }, shared, { location: 'node_modules/b', name: 'b', version: '1.0.1' }, { location: 'node_modules/a', name: 'a', version: '1.2.3' }],
    edges: [
      { from: '', to: 'node_modules/g', requestedName: 'g', type: 'dependencies', spec: '^2.0.0' },
      { from: 'node_modules/g', to: 'node_modules/b', requestedName: 'b', type: 'dependencies', spec: '^1.0.0' },
      { from: 'node_modules/b', to: 'node_modules/a', requestedName: 'a', type: 'dependencies', spec: '1.2.3' },
    ],
  })
  const c = response('c@1.0.0', {
    nodes: [{ location: '', name: 'app', version: '1.0.0' }, shared, { location: 'node_modules/c', name: 'c', version: '1.0.0' }, { location: 'node_modules/a', name: 'a', version: '1.2.3' }],
    edges: [
      { from: '', to: 'node_modules/g', requestedName: 'g', type: 'dependencies', spec: '^2.0.0' },
      { from: 'node_modules/g', to: 'node_modules/c', requestedName: 'c', type: 'dependencies', spec: '^1.0.0' },
      { from: 'node_modules/c', to: 'node_modules/a', requestedName: 'a', type: 'dependencies', spec: '^1.2.0' },
    ],
  })
  const graph = await readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }, { name: 'c', version: '1.0.0' }], { run: runner([b, c]) })
  assert.deepEqual([...graph.nodes.keys()].sort(), ['', 'node_modules/a', 'node_modules/b', 'node_modules/c', 'node_modules/g'])
  assert.equal(graph.edges.length, 5)
  assert.equal(graph.edges.filter(e => e.from === '' && e.to === 'node_modules/g').length, 1)
})

test('keeps repeated names at different locations distinct', async () => {
  const nodes = [{ location: '', name: 'app', version: '1.0.0' }, { location: 'node_modules/a', name: 'a', version: '1.2.3' }, { location: 'node_modules/b', name: 'b', version: '1.0.1' }, { location: 'node_modules/x/node_modules/b', name: 'b', version: '1.0.1' }]
  const edges = [
    { from: '', to: 'node_modules/b', requestedName: 'b', type: 'dependencies', spec: '^1.0.0' },
    { from: 'node_modules/b', to: 'node_modules/a', requestedName: 'a', type: 'dependencies', spec: '1.2.3' },
  ]
  const graph = await readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { run: runner([response('b@1.0.1', { nodes, edges })]) })
  assert.equal(graph.nodes.size, 4)
})

test('preserves alias identity: the node is the real package, the edge keeps the requested name and verbatim spec', async () => {
  const edges = [
    { from: '', to: 'node_modules/b', requestedName: 'b', type: 'dependencies', spec: '^1.0.0' },
    { from: 'node_modules/b', to: 'node_modules/a', requestedName: 'alias-a', type: 'dependencies', spec: 'npm:a@1.2.3' },
  ]
  const graph = await readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { run: runner([response('b@1.0.1', { edges })]) })
  assert.deepEqual(graph.edges.find(e => e.to === 'node_modules/a'), edges[1])
  assert.equal(graph.nodes.get('node_modules/a').name, 'a')
})

test('returns an empty graph without launching anything when there are no parents', async () => {
  const calls = []
  const graph = await readUpstream('/project', target, [], { run: runner([], calls) })
  assert.equal(graph.nodes.size, 0)
  assert.deepEqual(graph.edges, [])
  assert.equal(calls.length, 0)
})

const bad = (label, mutate) => ({ label, value: (() => {
  const value = response('b@1.0.1')
  mutate(value)
  return value
})() })
for (const { label, value } of [
  bad('wrong schema version', (v) => {
    v.schemaVersion = 1
  }),
  bad('different target package', (v) => {
    v.result.package = 'z'
  }),
  bad('different target version', (v) => {
    v.result.version = '9.9.9'
  }),
  bad('missing upstream', (v) => {
    delete v.upstream
  }),
  bad('malformed node', (v) => {
    v.upstream.nodes[1] = { location: 'node_modules/a', name: 7, version: '1.2.3' }
  }),
  bad('edge endpoint that is not a node', (v) => {
    v.upstream.edges.push({ from: 'node_modules/b', to: 'node_modules/missing', requestedName: 'm', type: 'dependencies', spec: '1' })
  }),
  bad('edge without a verbatim spec', (v) => {
    delete v.upstream.edges[0].spec
  }),
  bad('selected parent not a direct dependent of the target', (v) => {
    v.result.requirements[0].directDependents = []
  }),
  bad('duplicate node location', (v) => {
    v.upstream.nodes.push({ location: 'node_modules/a', name: 'a', version: '1.2.3' })
  }),
]) {
  test(`rejects an unusable upstream response: ${label}`, async () => {
    await assert.rejects(readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { run: runner([value]) }), /npm-dep-paths|upstream/i)
  })
}

test('rejects failed commands, invalid JSON and conflicting node identities across calls', async () => {
  await assert.rejects(readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { run: runner([{ code: 1, stdout: '', stderr: 'boom' }]) }), /npm-dep-paths failed.*boom/)
  await assert.rejects(readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }], { run: runner(['not json']) }), /invalid JSON/i)
  const other = response('c@1.0.0')
  other.upstream.nodes.find(n => n.location === 'node_modules/a').version = '1.2.4'
  await assert.rejects(readUpstream('/project', target, [{ name: 'b', version: '1.0.1' }, { name: 'c', version: '1.0.0' }], { run: runner([response('b@1.0.1'), other]) }), /conflict/i)
})
