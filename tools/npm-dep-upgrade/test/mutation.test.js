import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { buildMutation } from '../src/mutation.js'
import { createScopeProbe } from '../src/scopes.js'
import { loadProject } from '../src/project.js'
import { loadGraph } from '../src/graph.js'
import { gitProject } from './helpers/git-project.js'
test('direct mutations preserve operators and all compatible declaration sections', async (t) => {
  const f = await gitProject(t)
  f.manifest.devDependencies = { 'e2e-target': '~6.0.8' }
  f.lock.packages[''] = f.manifest
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest, null, 2) + '\n')
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock))
  const p = await loadProject(f.root), g = await loadGraph(f.root)
  const incoming = g.edges.filter(e => e.to === 'node_modules/e2e-target')
  const e = { item: { package: 'e2e-target', targetLocation: 'node_modules/e2e-target' }, graph: g, incoming, directDeclarations: incoming.map(x => ({ field: x.type, requestedName: x.requestedName, spec: x.rawSpec })) }
  const m = await buildMutation(p, e, { version: '6.0.12' })
  const updated = JSON.parse(m.cleanupBytes)
  assert.equal(JSON.parse(m.applyBytes).dependencies['e2e-target'], '6.0.12')
  assert.equal(updated.dependencies['e2e-target'], '^6.0.12')
  assert.equal(updated.devDependencies['e2e-target'], '~6.0.12')
  assert.ok(m.cleanupBytes)
})
test('transitive mutations preserve direct parent specification and clean up exact original bytes', async (t) => {
  const f = await gitProject(t)
  f.manifest.dependencies = { 'e2e-parent-a': '^1.2.0' }
  f.lock.packages[''] = f.manifest
  f.lock.packages['node_modules/e2e-parent-a'] = { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } }
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest, null, 2) + '\n')
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock))
  const p = await loadProject(f.root), graph = await loadGraph(f.root)
  const e = { item: { package: 'e2e-target', targetLocation: 'node_modules/e2e-target' }, graph, incoming: graph.edges.filter(x => x.to === 'node_modules/e2e-target'), directDeclarations: [], directDependents: [{ location: 'node_modules/e2e-parent-a' }], upstream: [] }
  const m = await buildMutation(p, e, { version: '6.0.12' }, { scratchRoot: f.root })
  assert.deepEqual(JSON.parse(m.applyBytes).overrides, { 'e2e-parent-a@1.2.4': { '.': '$e2e-parent-a', 'e2e-target': '6.0.12' } })
  assert.deepEqual(m.cleanupBytes, p.manifestBytes)
  const probe = await createScopeProbe(p, f.root)
  const result = await probe(JSON.parse(m.applyBytes).overrides)
  assert.equal(result.changedParentSpecs.filter(x => x.from === '').length, 0)
})
test('temporary target rule preserves nested existing supporting overrides', async (t) => {
  const f = await gitProject(t)
  f.manifest.dependencies = { 'e2e-parent-a': '^1.2.0' }
  f.manifest.overrides = { 'e2e-parent-a@1.2.4': { '.': '$e2e-parent-a', 'e2e-target': { '.': '^6.0.8', 'e2e-helper': '2.0.5' } } }
  f.lock.packages[''] = f.manifest
  f.lock.packages['node_modules/e2e-parent-a'] = { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } }
  f.lock.packages['node_modules/e2e-target'].dependencies = { 'e2e-helper': '^2.0.0' }
  f.lock.packages['node_modules/e2e-helper'] = { version: '2.0.5' }
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest))
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock))
  const p = await loadProject(f.root), graph = await loadGraph(f.root)
  const e = { item: { package: 'e2e-target', targetLocation: 'node_modules/e2e-target' }, graph, incoming: graph.edges.filter(x => x.to === 'node_modules/e2e-target'), directDeclarations: [], directDependents: [{ location: 'node_modules/e2e-parent-a' }], upstream: [] }
  const m = await buildMutation(p, e, { version: '6.0.12' }, { scratchRoot: f.root })
  assert.deepEqual(JSON.parse(m.applyBytes).overrides['e2e-parent-a@1.2.4']['e2e-target'], { '.': '6.0.12', 'e2e-helper': '2.0.5' })
})
