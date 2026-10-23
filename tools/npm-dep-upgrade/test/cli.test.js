import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/cli.js'
const capture = () => {
  let stdout = '', stderr = ''
  return { io: { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } }, out: () => stdout, err: () => stderr }
}
test('help/version bypass project mutation and argument failures emit no success report', async () => {
  const c = capture()
  assert.equal(await main(['--help'], c.io), 0)
  assert.match(c.out(), /Usage: npm-dep-upgrade \[project\] <id-or-prefix>/)
  assert.match(c.out(), /default:.*current directory/)
  const bad = capture()
  assert.equal(await main(['--to', '6.0.12'], bad.io), 1)
  assert.equal(bad.out(), '')
  assert.match(bad.err(), /arguments/i)
})
test('failed planner precondition never emits success or commits', async () => {
  const c = capture(), calls = []
  const deps = { preflightGit: async () => {
    calls.push('git')
    throw new Error('dirty dependency files')
  } }
  assert.equal(await main(['abcdef0'], c.io, deps), 1)
  assert.deepEqual(calls, ['git'])
  assert.equal(c.out(), '')
  assert.match(c.err(), /dirty/)
})
test('direct transaction verifies then commits before emitting a completed result', async (t) => {
  const { gitProject } = await import('./helpers/git-project.js')
  const { preflightGit } = await import('../src/git.js')
  const { loadGraph } = await import('../src/graph.js')
  const { itemId } = await import('../src/planner.js')
  const { readFile, writeFile, mkdir } = await import('node:fs/promises'), path = await import('node:path')
  const f = await gitProject(t), guard = await preflightGit(f.root), graph = await loadGraph(f.root), events = []
  const item = { id: itemId('e2e-target', 'node_modules/e2e-target'), package: 'e2e-target', version: '6.0.9', targetLocation: 'node_modules/e2e-target', minimumSafeVersion: '6.0.10', resolution: 'complete', choices: [{ strategy: 'update-within-declared-range', targetPackage: 'e2e-target', targetLocation: 'node_modules/e2e-target', currentVersion: '6.0.9', targetVersion: '6.0.12', affectedConsumers: [{ location: '', requestedName: 'e2e-target', type: 'dependencies' }] }] }
  const evidence = { item, graph, auditRows: [], incoming: graph.edges, directDeclarations: [{ field: 'dependencies', requestedName: 'e2e-target', spec: '^6.0.8' }], upstream: [] }
  const c = capture()
  const deps = { preflightGit: async () => guard, readPlanner: async () => {
    events.push('plan')
    return { rows: [item] }
  }, readEvidence: async () => evidence, executeActions: async () => {
    const manifest = { ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }, lock = structuredClone(f.lock)
    lock.packages[''] = manifest
    lock.packages['node_modules/e2e-target'].version = '6.0.12'
    const files = { 'package.json': Buffer.from(JSON.stringify(manifest)), 'package-lock.json': Buffer.from(JSON.stringify(lock)) }
    const expected = { nodes: new Map([...graph.nodes].map(([loc, node]) => [loc, loc === item.targetLocation ? { ...node, version: '6.0.12' } : node])), edges: graph.edges.map(edge => ({ ...edge, rawSpec: '^6.0.12', effectiveSpec: '^6.0.12' })) }
    return { snapshots: [{ choiceIndex: 0, files, graph: expected, candidate: { version: '6.0.12' }, changedVersions: new Map([['e2e-target', ['6.0.12']]]), supportingChanges: [] }], actions: [{ ...item.choices[0], outcome: 'applied' }], coverage: { resolution: 'complete' } }
  }, loadNpmContext: async () => ({ minAgeDays: 7, installArgs: ['install', '--ignore-scripts', '--min-release-age=7'] }), readCatalog: async () => ({ versions: ['6.0.12'], releaseTimes: new Map([['6.0.12', '2026-01-01T00:00:00Z']]) }), readCandidateAdvisories: async () => new Map(), installProject: async (installRoot) => {
    events.push('install')
    const manifest = JSON.parse(await readFile(path.join(installRoot, 'package.json')))
    const lock = structuredClone(f.lock)
    lock.packages[''] = manifest
    lock.packages['node_modules/e2e-target'].version = '6.0.12'
    await writeFile(path.join(installRoot, 'package-lock.json'), JSON.stringify(lock))
    await mkdir(path.join(installRoot, 'node_modules', 'e2e-target'), { recursive: true })
    await writeFile(path.join(installRoot, 'node_modules', 'e2e-target', 'package.json'), JSON.stringify({ name: 'e2e-target', version: '6.0.12' }))
  }, verifyFinalSecurity: async () => {
    assert.equal(c.out(), '')
    events.push('security')
  } }
  assert.equal(await main([item.id, '--format', 'json'], c.io, deps), 0, c.err())
  const result = JSON.parse(c.out())
  assert.equal(result.actions[0].targetVersion, '6.0.12')
  assert.match(result.commits[0].hash, /^[a-f0-9]{40,64}$/)
  assert.deepEqual(events, ['plan', 'install', 'security', 'install', 'security'])
})

test('CLI passes the explicit resolved project to preflight without changing cwd', async () => {
  const path = await import('node:path'), cwd = process.cwd(), target = path.resolve(cwd, '../target project & symbols'), seen = []
  const c = capture()
  assert.equal(await main(['../target project & symbols', 'abcdef0'], c.io, { preflightGit: async (root) => {
    seen.push(root)
    throw new Error('fixture preflight stopped')
  } }), 1)
  assert.deepEqual(seen, [target])
  assert.equal(process.cwd(), cwd)
  assert.equal(c.out(), '')
})
