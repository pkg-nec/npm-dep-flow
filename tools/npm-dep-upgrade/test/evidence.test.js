import assert from 'node:assert/strict'
import test from 'node:test'
import { readEvidence } from '../src/evidence.js'
import { loadProject } from '../src/project.js'
import { gitProject } from './helpers/git-project.js'
test('fresh evidence requires uncached matching audit and retains all incoming requirements', async (t) => {
  const f = await gitProject(t)
  const item = { package: 'e2e-target', version: '6.0.9', targetLocation: 'node_modules/e2e-target' }
  const advisory = { id: 1, title: 'Fixture', url: 'https://example.test/1', severity: 'high', range: '<6.0.10' }
  const report = { schemaVersion: 2, auditedAt: '2026-10-20T00:00:00.000Z', rows: [{ package: item.package, version: item.version, severity: 'high', advisories: [advisory], requirements: [] }] }
  const run = async (command, args) => {
    assert.equal(command, 'npm-dep-audit')
    assert.ok(args.includes('--no-cache'))
    return { code: 0, stdout: JSON.stringify(report), stderr: '' }
  }
  const e = await readEvidence(await loadProject(f.root), item, run)
  assert.equal(e.incoming.length, 1)
  assert.equal(e.directDeclarations[0].spec, '^6.0.8')
  await assert.rejects(readEvidence(await loadProject(f.root), { ...item, version: '6.0.8' }, run), /stale|changed/i)
})
