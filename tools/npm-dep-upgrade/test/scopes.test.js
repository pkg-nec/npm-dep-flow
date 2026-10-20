import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitProject } from './helpers/git-project.js'
import { loadProject } from '../src/project.js'
import { readEvidence } from '../src/evidence.js'
import { createScopeProbe, planScopes } from '../src/scopes.js'
import { runProcess } from '../src/process.js'

const pathsCli = new URL('../../npm-dep-paths/bin/npm-dep-paths.js', import.meta.url)
const item = { package: 'e2e-target', version: '6.0.9', targetLocation: 'node_modules/e2e-target' }
const candidate = { version: '6.0.12' }

async function fixture(t, manifest, packages, { transformPaths = data => data } = {}) {
  const f = await gitProject(t)
  f.manifest.dependencies = manifest
  f.lock.packages = { '': f.manifest, ...packages, [item.targetLocation]: { version: item.version } }
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify(f.manifest))
  await writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(f.lock))
  const project = await loadProject(f.root)
  const run = async (command, args, options) => {
    if (command === 'npm-dep-paths') {
      const result = await runProcess(process.execPath, [fileURLToPath(pathsCli), ...args], options)
      if (result.code) return result
      return { ...result, stdout: JSON.stringify(transformPaths(JSON.parse(result.stdout))) }
    }
    assert.equal(command, 'npm-dep-audit')
    return { code: 0, stderr: '', stdout: JSON.stringify({ schemaVersion: 2, auditedAt: new Date().toISOString(), rows: [{ package: item.package, version: item.version, advisories: [] }] }) }
  }
  return { project, evidence: await readEvidence(project, item, run), probeScope: await createScopeProbe(project, f.root) }
}

test('a compact graph with 2048 ancestry routes uses its immediate parent scope', async (t) => {
  const packages = { 'node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } } }
  for (let level = 0; level < 11; level++) {
    for (const side of ['a', 'b']) {
      const dependencies = level === 10 ? { 'e2e-parent': '1.2.4' } : { [`e2e-layer-${level + 1}-a`]: '1.0.0', [`e2e-layer-${level + 1}-b`]: '1.0.0' }
      packages[`node_modules/e2e-layer-${level}-${side}`] = { version: '1.0.0', dependencies }
    }
  }
  const f = await fixture(t, { 'e2e-layer-0-a': '1.0.0', 'e2e-layer-0-b': '1.0.0' }, packages)
  const result = await planScopes(f.project, f.evidence, candidate, f)
  assert.deepEqual(result.overrides, { 'e2e-parent@1.2.4': { 'e2e-target': '6.0.12' } })
  assert.deepEqual(result.scopedLocations, ['node_modules/e2e-target'])
})

test('paths evidence filters same-version installations by the selected target location', async (t) => {
  const f = await fixture(t, { 'e2e-parent-a': '1.0.0', 'e2e-parent-b': '1.0.0' }, {
    'node_modules/e2e-parent-a': { version: '1.0.0', dependencies: { 'e2e-target': '^6.0.8' } },
    'node_modules/e2e-parent-b': { version: '1.0.0', dependencies: { 'e2e-target': '6.0.9' } },
    'node_modules/e2e-parent-b/node_modules/e2e-target': { version: '6.0.9' },
  })
  assert.deepEqual(f.evidence.directDependents, [{ name: 'e2e-parent-a', version: '1.0.0', location: 'node_modules/e2e-parent-a', targetLocation: 'node_modules/e2e-target', type: 'dependencies', requestedName: 'e2e-target', declaredRequirement: '^6.0.8' }])
  const result = await planScopes(f.project, f.evidence, candidate, f)
  assert.deepEqual(result.overrides, { 'e2e-parent-a@1.0.0': { '.': '$e2e-parent-a', 'e2e-target': '6.0.12' } })
})

test('repeated parent versions use upstream evidence to isolate the selected target', async (t) => {
  const f = await fixture(t, { 'e2e-ancestor-a': '1.0.0', 'e2e-ancestor-b': '1.0.0', 'e2e-parent': '2.0.0' }, {
    'node_modules/e2e-ancestor-a': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-ancestor-b': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-parent': { version: '2.0.0' },
    'node_modules/e2e-ancestor-a/node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } },
    'node_modules/e2e-ancestor-b/node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '6.0.9' } },
    'node_modules/e2e-ancestor-b/node_modules/e2e-target': { version: '6.0.9' },
  })
  const result = await planScopes(f.project, f.evidence, candidate, f)
  assert.deepEqual(result.overrides, { 'e2e-ancestor-a@1.0.0': { '.': '$e2e-ancestor-a', 'e2e-parent@1.2.4': { 'e2e-target': '6.0.12' } } })
  const impact = await f.probeScope(result.overrides)
  assert.deepEqual(impact.affectedEdges.map(e => e.to), ['node_modules/e2e-target'])
})

test('incomplete paths evidence cannot silently omit a selected incoming requirement', async (t) => {
  await assert.rejects(fixture(t, { 'e2e-parent': '1.2.4' }, {
    'node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } },
  }, { transformPaths: data => ({ ...data, result: { ...data.result, requirements: [] } }) }), { code: 'INVALID_PATHS' })
})

test('conflicting paths evidence cannot change an original incoming requirement', async (t) => {
  await assert.rejects(fixture(t, { 'e2e-parent': '1.2.4' }, {
    'node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } },
  }, { transformPaths: (data) => {
    data.result.requirements[0].declaredRequirement = '^7.0.0'
    return data
  } }), { code: 'INVALID_PATHS' })
})

test('cyclic ancestry terminates with refusal when scopes also affect another target copy', async (t) => {
  const f = await fixture(t, { 'e2e-parent': '1.2.4', 'e2e-ancestor': '1.0.0' }, {
    'node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8', 'e2e-cycle': '1.0.0' } },
    'node_modules/e2e-cycle': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-ancestor': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-ancestor/node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '6.0.9' } },
    'node_modules/e2e-ancestor/node_modules/e2e-target': { version: '6.0.9' },
  })
  await assert.rejects(planScopes(f.project, f.evidence, candidate, f), { code: 'UNSUPPORTED_SCOPE' })
})

test('one parent selector retains both physical branches when a deeper scope is required', async (t) => {
  const f = await fixture(t, { 'e2e-ancestor-a': '1.0.0', 'e2e-ancestor-b': '1.0.0', 'e2e-ancestor-c': '1.0.0', 'e2e-parent': '2.0.0' }, {
    'node_modules/e2e-parent': { version: '2.0.0' },
    'node_modules/e2e-ancestor-a': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-ancestor-b': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-ancestor-c': { version: '1.0.0', dependencies: { 'e2e-parent': '1.2.4' } },
    'node_modules/e2e-ancestor-a/node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '^6.0.8' } },
    'node_modules/e2e-ancestor-b/node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '~6.0.8' } },
    'node_modules/e2e-ancestor-c/node_modules/e2e-parent': { version: '1.2.4', dependencies: { 'e2e-target': '6.0.9' } },
    'node_modules/e2e-ancestor-c/node_modules/e2e-target': { version: '6.0.9' },
  })
  const result = await planScopes(f.project, f.evidence, candidate, f)
  assert.deepEqual(result.overrides, {
    'e2e-ancestor-b@1.0.0': { '.': '$e2e-ancestor-b', 'e2e-parent@1.2.4': { 'e2e-target': '6.0.12' } },
    'e2e-ancestor-a@1.0.0': { '.': '$e2e-ancestor-a', 'e2e-parent@1.2.4': { 'e2e-target': '6.0.12' } },
  })
  const impact = await f.probeScope(result.overrides)
  assert.equal(impact.affectedEdges.length, 2)
  assert.ok(impact.affectedEdges.every(e => e.to === item.targetLocation))
})
