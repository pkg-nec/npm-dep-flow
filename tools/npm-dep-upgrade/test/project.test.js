import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { loadProject } from '../src/project.js'
import { loadGraph } from '../src/graph.js'
import { gitProject } from './helpers/git-project.js'
test('graph preserves all root declarations and physical target identity', async t => {
 const f = await gitProject(t)
 f.manifest.devDependencies = { 'e2e-target': '~6.0.8' }
 f.manifest.peerDependencies = { 'e2e-target': '^6.0.8' }
 f.lock.packages[''] = f.manifest
 await writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest))
 await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock))
 const p = await loadProject(f.root)
 const g = await loadGraph(f.root)
 assert.equal(g.nodes.get('node_modules/e2e-target').version, '6.0.9')
 assert.deepEqual(g.edges.filter(e => e.from === '').map(e=>e.type).sort(), ['dependencies','devDependencies','peerDependencies'])
 assert.equal(p.lock.lockfileVersion, 3)
})
test('project rejects unsupported workspaces and inconsistent root metadata', async t => {
 const f = await gitProject(t)
 await writeFile(path.join(f.root,'package.json'), JSON.stringify({ ...f.manifest, workspaces: [] }))
 await assert.rejects(loadProject(f.root), /workspaces/i)
 await writeFile(path.join(f.root,'package.json'), JSON.stringify({ ...f.manifest, version: '2.0.0' }))
 await assert.rejects(loadProject(f.root), /root|stale/i)
})
