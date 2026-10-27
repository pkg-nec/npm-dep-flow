import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/cli.js'
import { renderJson } from '../src/report.js'

test('planner verifies split coverage and propagates resolver failures without partial stdout', async () => {
  const row = { package: 'a', version: '1.2.3', severity: 'high', advisories: [{ range: '<1.2.5' }], requirements: ['1.2.3', '^1.2.0'].map((spec, i) => ({ declaredRequirement: spec, directDependents: [{ location: `node_modules/p${i}`, targetLocation: 'node_modules/a', requestedName: 'a', type: 'dependencies' }] })) }
  let stdout = '', stderr = '', seen = []
  const io = {
    stdout: {
      write: (s) => {
        stdout += s
      },
    },
    stderr: {
      write: (s) => {
        stderr += s
      },
    },
  }
  const deps = { loadProject: async root => ({ root }), runNpmDepAudit: async () => ({ auditedAt: new Date().toISOString(), rows: [row] }), runNpmDepVersions: async () => ({ versions: ['1.2.5'], fetchedAt: new Date().toISOString() }), resolveChoices: async (project, item, choices, options) => {
    seen = [item, choices, options]
    return { choices, coverage: { resolution: 'partial' }, freshAt: Date.now() }
  }, readUpstream: async () => ({ nodes: new Map(), edges: [] }), readReleasePolicy: async () => ({ minAgeDays: 7, cutoffMs: null }), renderJson }
  assert.equal(await main(['--no-cache', '--format', 'json'], io, deps), 0)
  assert.equal(JSON.parse(stdout).rows[0].resolution, 'partial')
  assert.equal(seen[2].noCache, true)
  stdout = ''
  stderr = ''
  deps.resolveChoices = async () => {
    throw new Error('resolver unavailable')
  }
  assert.equal(await main(['--no-cache', '--format', 'json'], io, deps), 1)
  assert.equal(stdout, '')
  assert.match(stderr, /resolver unavailable/)
})

test('a finding whose jointly resolved coverage is none never carries choices', async () => {
  const row = { package: 'a', version: '1.2.3', severity: 'high', advisories: [{ range: '<1.2.5' }], requirements: ['1.2.3', '^1.2.0'].map((spec, i) => ({ declaredRequirement: spec, directDependents: [{ location: `node_modules/p${i}`, targetLocation: 'node_modules/a', type: 'dependencies', requestedName: 'a', name: `p${i}`, version: '1.0.0' }] })) }
  let stdout = ''
  const io = {
    stdout: {
      write: (s) => {
        stdout += s
      },
    },
    stderr: { write: () => {} },
  }
  const deps = {
    loadProject: async root => ({ root }), runNpmDepAudit: async () => ({ auditedAt: new Date().toISOString(), rows: [row] }),
    runNpmDepVersions: async () => ({ versions: ['1.2.5'], fetchedAt: new Date().toISOString() }),
    resolveChoices: async (project, item, choices) => ({ choices, coverage: { resolution: 'none', clearedConsumers: [] }, freshAt: Date.now() }),
    readUpstream: async () => ({ nodes: new Map(), edges: [] }), readReleasePolicy: async () => ({ minAgeDays: 7, cutoffMs: null }), renderJson,
  }
  assert.equal(await main(['--no-cache', '--format', 'json'], io, deps), 0)
  const [result] = JSON.parse(stdout).rows
  assert.equal(result.resolution, 'none')
  assert.deepEqual(result.choices, [])
})
