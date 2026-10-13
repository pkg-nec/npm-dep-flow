import test from 'node:test'
import assert from 'node:assert/strict'
import { renderText, renderJson } from '../src/render.js'

const project = { manifest: { name: 'app', version: '1.0.0' } }
const root = { name: 'app', version: '1.0.0', location: '', incoming: null }
const route = (parent, spec) => [
  root,
  { name: parent, version: '1.0.0', location: `node_modules/${parent}`, incoming: { name: parent, type: 'dependencies', spec: '^1' } },
  { name: 'dep', version: '5.0.9', location: 'node_modules/dep', incoming: { name: 'dep', type: 'dependencies', spec } },
]
const result = { package: 'dep', version: '5.0.9', routeCount: 2, routes: [route('a', '^5.0.5'), route('b', '5.0.9')] }

test('renders every shared-installation route and incoming spec', () => {
  const text = renderText(project, [result])
  assert.match(text, /dep@5\.0\.9 — 2 routes/)
  assert.match(text, /├─┬ a@1\.0\.0 \[dependency: \^1\]/)
  assert.match(text, /└─┬ b@1\.0\.0 \[dependency: \^1\]/)
  assert.match(text, /dep@5\.0\.9 \[dependency: \^5\.0\.5\]/)
  assert.match(text, /dep@5\.0\.9 \[dependency: 5\.0\.9\]/)
  assert.equal((text.match(/dep@5\.0\.9 \[dependency:/g) || []).length, 2)
  assert.equal(text.endsWith('\n'), true)
})

test('merges common prefixes but keeps branches distinct', () => {
  const first = [root, { name: 'a', version: '1.0.0', location: 'node_modules/a', incoming: { name: 'a', type: 'dependencies', spec: '^1' } },
    { name: 'left', version: '1.0.0', location: 'node_modules/left', incoming: { name: 'left', type: 'dependencies', spec: '^1' } },
    { name: 'dep', version: '5.0.9', location: 'node_modules/dep', incoming: { name: 'dep', type: 'dependencies', spec: '^5' } }]
  const second = [root, first[1], { name: 'right', version: '1.0.0', location: 'node_modules/right', incoming: { name: 'right', type: 'dependencies', spec: '^1' } }, first[3]]
  const text = renderText(project, [{ ...result, routes: [first, second] }])
  assert.equal((text.match(/a@1\.0\.0/g) || []).length, 1)
  assert.match(text, /left@1\.0\.0/)
  assert.match(text, /right@1\.0\.0/)
  assert.equal((text.match(/dep@5\.0\.9 \[dependency:/g) || []).length, 2)
})

test('renders one section per version and a clean empty result', () => {
  const other = { package: 'dep', version: '2.1.7', routeCount: 1, routes: [[root, { name: 'dep', version: '2.1.7', location: 'node_modules/old/dep', incoming: { name: 'dep', type: 'dependencies', spec: '^2' } }]] }
  const text = renderText(project, [other, result])
  assert.match(text, /dep@2\.1\.7 — 1 route[\s\S]*dep@5\.0\.9 — 2 routes/)
  assert.match(renderText(project, []), /No matching installed packages\./)
})

test('uses separate exact and name JSON envelopes with complete node data', () => {
  const exact = JSON.parse(renderJson(project, { kind: 'exact', name: 'dep', version: '5.0.9' }, [result]))
  assert.equal(exact.schemaVersion, 1)
  assert.deepEqual(exact.project, { name: 'app', version: '1.0.0' })
  assert.equal(exact.selector, 'dep@5.0.9')
  assert.equal(exact.result.routeCount, 2)
  assert.equal(exact.result.routes[0][0].incoming, null)
  assert.deepEqual(exact.result.routes[0][2], { name: 'dep', version: '5.0.9', location: 'node_modules/dep', incoming: { name: 'dep', type: 'dependencies', spec: '^5.0.5' } })
  assert.equal(Object.hasOwn(exact, 'results'), false)
  const byName = JSON.parse(renderJson(project, { kind: 'name', name: 'dep' }, [result]))
  assert.equal(byName.results.length, 1)
  assert.equal(Object.hasOwn(byName, 'result'), false)
  assert.equal(renderJson(project, { kind: 'name', name: 'dep' }, []).endsWith('\n'), true)
})

test('keeps text control characters on one line while JSON preserves their values', () => {
  const odd = { ...result, routes: [route('a', '^5\n<next>|\u001b[31m')] }
  const text = renderText(project, [odd])
  assert.match(text, /\^5\\n<next>\|\\x1b\[31m/)
  assert.equal(JSON.parse(renderJson(project, { kind: 'exact', name: 'dep', version: '5.0.9' }, [odd])).result.routes[0][2].incoming.spec, '^5\n<next>|\u001b[31m')
})

test('renders a deep logical route without a call-stack limit', () => {
  const deep = [root]
  for (let i = 0; i < 6000; i++) {
    const name = `step-${i}`
    deep.push({ name, version: '1.0.0', location: `node_modules/${name}`,
      incoming: { name, type: 'dependencies', spec: '1.0.0' } })
  }
  const text = renderText(project, [{ package: 'step-5999', version: '1.0.0', routeCount: 1, routes: [deep] }])
  assert.match(text, /step-5999@1\.0\.0 \[dependency: 1\.0\.0\]/)
})
