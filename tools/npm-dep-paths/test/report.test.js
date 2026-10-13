import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSummaryText, renderSummaryJson, renderUpstreamText } from '../src/report.js'

const project = { manifest: { name: 'demo', version: '1.0.0' } }
const selector = { kind: 'exact', name: 'brace-expansion', version: '5.0.9' }
const dependent = (name, location, targetLocation = 'target', type = 'dependencies', requestedName = 'brace-expansion') => ({
  name, version: '1.0.0', location, targetLocation, type, requestedName,
})
const result = {
  package: 'brace-expansion', version: '5.0.9', requirements: [
    { declaredRequirement: '5.0.9', directDependents: [dependent('nx', 'nx')] },
    { declaredRequirement: '^5.0.5', directDependents: [dependent('mini', 'mini-a'), dependent('mini', 'mini-b')] },
  ],
}
const upstream = {
  selectedDependent: 'mini@1.0.0', rootLocation: '', selectedLocations: ['mini-a'], targetLocations: ['target'],
  topLevelLocations: ['a', 'b'],
  nodes: [
    { location: '', name: 'demo', version: '1.0.0' },
    { location: 'a', name: 'a', version: '1.0.0' },
    { location: 'b', name: 'b', version: '1.0.0' },
    { location: 'mini-a', name: 'mini', version: '1.0.0' },
    { location: 'target', name: 'brace-expansion', version: '5.0.9' },
  ],
  edges: [
    { from: '', to: 'a', requestedName: 'a', type: 'devDependencies', spec: '1.0.0' },
    { from: '', to: 'b', requestedName: 'b', type: 'dependencies', spec: '^1' },
    { from: 'a', to: 'mini-a', requestedName: 'mini', type: 'dependencies', spec: '1.0.0' },
    { from: 'b', to: 'mini-a', requestedName: 'mini', type: 'dependencies', spec: '^1' },
    { from: 'mini-a', to: 'target', requestedName: 'brace-expansion', type: 'dependencies', spec: '^5.0.5' },
  ],
}

test('puts each declared requirement before its direct dependents and identifies repeated installations', () => {
  const text = renderSummaryText(project, [result])
  assert.match(text, /Declared requirement\s+Direct dependents/)
  assert.match(text, /5\.0\.9\s+nx@1\.0\.0 \[dependencies\]/)
  assert.match(text, /\^5\.0\.5\s+mini@1\.0\.0 \[dependencies\] \(2 installations\)/)
  assert.equal(text.endsWith('\n'), true)
  assert.equal(renderSummaryText(project, []), 'No matching installed packages.\n')
})

test('normal JSON has two-key requirement groups and no graph or routes', () => {
  const exact = JSON.parse(renderSummaryJson(project, selector, [result]))
  assert.equal(exact.schemaVersion, 2)
  assert.deepEqual(Object.keys(exact.result.requirements[0]), ['declaredRequirement', 'directDependents'])
  assert.deepEqual(exact.result.requirements[0].directDependents[0], dependent('nx', 'nx'))
  assert.equal(Object.hasOwn(exact, 'upstream'), false)
  assert.equal(Object.hasOwn(exact.result, 'routes'), false)
  assert.equal(Object.hasOwn(exact.result, 'routeCount'), false)
  const name = JSON.parse(renderSummaryJson(project, { kind: 'name', name: 'brace-expansion' }, [result]))
  assert.deepEqual(name.results.map(item => item.version), ['5.0.9'])
  assert.deepEqual(JSON.parse(renderSummaryJson(project, { kind: 'name', name: 'missing' }, [])).results, [])
})

test('detailed JSON retains the full summary and attaches the selected upstream graph', () => {
  const normal = JSON.parse(renderSummaryJson(project, selector, [result]))
  const detailed = JSON.parse(renderSummaryJson(project, selector, [result], upstream))
  assert.deepEqual(detailed.result, normal.result)
  assert.deepEqual(detailed.upstream, upstream)
})

test('upstream overview lists each immediate parent and top-level declaration', () => {
  const text = renderUpstreamText(project, result, upstream)
  assert.match(text, /Upstream of mini@1\.0\.0/)
  assert.match(text, /requires brace-expansion@5\.0\.9: \^5\.0\.5/)
  assert.match(text, /5 packages, 5 links/)
  assert.match(text, /Immediate parents \(2\):[\s\S]*a@1\.0\.0[\s\S]*b@1\.0\.0/)
  assert.match(text, /Top-level packages \(2\):[\s\S]*a@1\.0\.0[\s\S]*b@1\.0\.0/)
})

test('focused text shows every connecting edge and refers to a repeated node', () => {
  const text = renderUpstreamText(project, result, upstream, { name: 'a', version: '1.0.0' })
  assert.match(text, /demo@1\.0\.0/)
  assert.match(text, /a@1\.0\.0 \[devDependencies: 1\.0\.0\]/)
  assert.match(text, /b@1\.0\.0 \[dependencies: \^1\]/)
  assert.match(text, /mini@1\.0\.0 \[dependencies: \^1\].*ref/)
  assert.match(text, /brace-expansion@5\.0\.9 \[dependencies: \^5\.0\.5\]/)
  const cyclic = { ...upstream, edges: [...upstream.edges, { from: 'mini-a', to: 'a', requestedName: 'a', type: 'peerDependencies', spec: '^1' }] }
  assert.match(renderUpstreamText(project, result, cyclic, { name: 'a', version: '1.0.0' }), /peerDependencies: \^1.*ref/)
})

test('preserves unusual specs in JSON and escapes text controls without losing alias identity', () => {
  const odd = { ...result, requirements: [{ declaredRequirement: 'npm:real@^5\n🌱', directDependents: [dependent('parent', 'parent', 'target', 'devDependencies', 'alias')] }] }
  const json = JSON.parse(renderSummaryJson(project, selector, [odd]))
  assert.equal(json.result.requirements[0].declaredRequirement, 'npm:real@^5\n🌱')
  assert.equal(json.result.requirements[0].directDependents[0].requestedName, 'alias')
  const text = renderSummaryText(project, [odd])
  assert.match(text, /npm:real@\^5\\n🌱/)
  assert.match(text, /requested as alias/)
  assert.equal(text.split('\n').length, 5)
})
