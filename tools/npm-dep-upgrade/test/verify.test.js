import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyGraph, verifyFinalSecurity } from '../src/verify.js'

const target = 'node_modules/e2e-target', helper = 'node_modules/e2e-helper', other = 'node_modules/other/node_modules/e2e-target'
const node = (location, name, version) => ({ location, name, version, resolved: null, integrity: null })
const edge = (from, to, requestedName, rawSpec) => ({ from, to, requestedName, rawSpec, effectiveSpec: rawSpec, type: 'dependencies', valid: true, optional: false })

function graph(version, helperVersion, helperRange) {
  return { nodes: new Map([['', node('', 'e2e-app', '1.0.0')], [target, node(target, 'e2e-target', version)], [helper, node(helper, 'e2e-helper', helperVersion)], [other, node(other, 'e2e-target', '6.0.9')]]), edges: [edge('', target, 'e2e-target', '^6.0.8'), edge(target, helper, 'e2e-helper', helperRange)] }
}

const before = graph('6.0.9', '2.0.5', '^2.0.0'), after = graph('6.0.12', '3.0.2', '^3.0.0')
const evidence = { item: { package: 'e2e-target', version: '6.0.9', targetLocation: target }, incoming: [before.edges[0]], graph: before, auditRows: [] }
const candidate = { version: '6.0.12', releasedAt: '2026-01-01T00:00:00.000Z' }
test('verification allows required helper upgrade while protecting other target installations', () => {
  const r = verifyGraph(before, after, evidence, candidate, { kind: 'direct' }, 'cleaned')
  assert.equal(r.supportingChanges[0].newVersion, '3.0.2')
  const bad = graph('6.0.12', '3.0.2', '^3.0.0')
  bad.nodes.set(other, node(other, 'e2e-target', '6.0.12'))
  assert.throws(() => verifyGraph(before, bad, evidence, candidate, { kind: 'direct' }, 'cleaned'), /other.*installation|scope/i)
})
test('verification rejects unrelated churn and invalid shared helper consumers', () => {
  const b = graph('6.0.9', '2.0.5', '^2.0.0'), a = graph('6.0.12', '3.0.2', '^3.0.0')
  b.nodes.set('node_modules/unrelated', node('node_modules/unrelated', 'unrelated', '1.0.0'))
  a.nodes.set('node_modules/unrelated', node('node_modules/unrelated', 'unrelated', '2.0.0'))
  assert.throws(() => verifyGraph(b, a, evidence, candidate, {}, 'cleaned'), /unrelated|outside/i)
  a.nodes.set('node_modules/unrelated', node('node_modules/unrelated', 'unrelated', '1.0.0'))
  a.edges.push(edge('node_modules/unrelated', helper, 'e2e-helper', '^2.0.0'))
  assert.throws(() => verifyGraph(b, a, evidence, candidate, {}, 'cleaned'), /invalid|requirement/i)
})
test('fresh security gate rejects advisory drift without silently changing version', async () => {
  const diff = verifyGraph(before, after, evidence, candidate, {}, 'cleaned')
  const deps = { readCandidateAdvisories: async () => new Map([['e2e-target', [{ range: '6.0.12' }]]]), readCatalog: async () => ({ releaseTimes: new Map([['6.0.12', candidate.releasedAt]]) }), readFreshAudit: async () => [] }
  await assert.rejects(verifyFinalSecurity(evidence, candidate, diff, { projectRoot: '/fixture', minAgeDays: 7 }, deps), /stale/i)
})
