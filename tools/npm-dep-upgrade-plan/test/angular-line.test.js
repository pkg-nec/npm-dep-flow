import assert from 'node:assert/strict'
import test from 'node:test'
import { ANGULAR_LINES, TOOLCHAIN_MEMBERS, TOOLCHAIN_STRATEGY } from '../src/angular-lines.js'
import { inLineScope, lineCandidateVersions, lineMembers } from '../src/angular-line.js'

const [line] = ANGULAR_LINES

const manifest = {
  devDependencies: { '@angular/cli': '^21.2.0', '@angular/build': '^21.2.0' },
}

function lock(cliVersion = '21.2.26', buildVersion = '21.2.26') {
  return {
    '': {},
    'node_modules/@angular/cli': { version: cliVersion },
    'node_modules/@angular/build': { version: buildVersion },
  }
}

test('exports constants', () => {
  assert.equal(TOOLCHAIN_STRATEGY, 'upgrade-angular-toolchain')
  assert.deepEqual(TOOLCHAIN_MEMBERS, ['@angular/cli', '@angular/build'])
})

test('lineMembers returns both members sharing a version', () => {
  assert.deepEqual(lineMembers(line, manifest, lock()), {
    version: '21.2.26',
    members: [
      { name: '@angular/cli', location: 'node_modules/@angular/cli', version: '21.2.26', requestedType: 'devDependencies' },
      { name: '@angular/build', location: 'node_modules/@angular/build', version: '21.2.26', requestedType: 'devDependencies' },
    ],
  })
})

test('lineMembers returns null when versions differ', () => {
  assert.equal(lineMembers(line, manifest, lock('21.2.26', '21.2.25')), null)
})

test('lineMembers returns null when cli is only transitive', () => {
  assert.equal(lineMembers(line, { devDependencies: { '@angular/build': '^21.2.0' } }, lock()), null)
})

test('lineMembers returns a single member when build is absent', () => {
  const result = lineMembers(line, { dependencies: { '@angular/cli': '^21.2.0' } }, {
    'node_modules/@angular/cli': { version: '21.2.26' },
  })
  assert.equal(result.members.length, 1)
  assert.equal(result.members[0].requestedType, 'dependencies')
  assert.equal(result.version, '21.2.26')
})

test('lineMembers returns null when a declared build is not installed', () => {
  assert.equal(lineMembers(line, manifest, { 'node_modules/@angular/cli': { version: '21.2.26' } }), null)
})

test('lineCandidateVersions keeps newer stable same-major versions ascending', () => {
  assert.deepEqual(
    lineCandidateVersions('21.2.26', ['21.2.25', '21.2.27', '21.3.0', '22.0.0', '21.2.28-rc.1']),
    ['21.2.27', '21.3.0'],
  )
})

test('inLineScope limits consumers near the members', () => {
  const nodes = new Map()
  for (const location of [
    'node_modules/@angular/cli',
    'node_modules/@angular/build',
    'node_modules/a',
    'node_modules/b',
    'node_modules/c',
    'node_modules/other',
  ]) nodes.set(location, { location, name: location.replace('node_modules/', ''), version: '1.0.0' })
  const graph = {
    nodes,
    edges: [
      { from: '', to: 'node_modules/@angular/cli' },
      { from: 'node_modules/@angular/cli', to: 'node_modules/a' },
      { from: 'node_modules/a', to: 'node_modules/b' },
      { from: 'node_modules/b', to: 'node_modules/c' },
      { from: '', to: 'node_modules/other' },
    ],
  }
  const { members } = lineMembers(line, manifest, lock())
  assert.equal(inLineScope('', graph, members), true)
  assert.equal(inLineScope('node_modules/@angular/build', graph, members), true)
  assert.equal(inLineScope('node_modules/a', graph, members), true)
  assert.equal(inLineScope('node_modules/b', graph, members), false)
  assert.equal(inLineScope('node_modules/c', graph, members), false)
  assert.equal(inLineScope('node_modules/other', graph, members), false)
})

const runtime = ANGULAR_LINES.find(candidate => candidate.key === 'runtime')
const RUNTIME_MEMBERS = ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router']
const runtimeManifest = {
  dependencies: Object.fromEntries(RUNTIME_MEMBERS.filter(name => name !== '@angular/compiler-cli').map(name => [name, '^21.2.0'])),
  devDependencies: { '@angular/compiler-cli': '^21.2.0', '@angular/cli': '^21.2.0' },
}
const without = (record, ...names) => Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)))
const runtimeLock = (versions = {}) => ({
  '': {},
  ...Object.fromEntries(RUNTIME_MEMBERS.map(name => [`node_modules/${name}`, { version: versions[name] ?? '21.2.25' }])),
  'node_modules/@angular/cli': { version: '21.2.26' },
})

test('lineMembers returns the seven runtime members across dependencies and devDependencies', () => {
  const result = lineMembers(runtime, runtimeManifest, runtimeLock())
  assert.equal(result.version, '21.2.25')
  assert.deepEqual(result.members.map(member => member.name), RUNTIME_MEMBERS)
  assert.deepEqual(result.members.find(member => member.name === '@angular/compiler-cli'), { name: '@angular/compiler-cli', location: 'node_modules/@angular/compiler-cli', version: '21.2.25', requestedType: 'devDependencies' })
  assert.ok(result.members.filter(member => member.name !== '@angular/compiler-cli').every(member => member.requestedType === 'dependencies'))
})

test('lineMembers returns null when @angular/core is not a root dependency', () => {
  const dependencies = without(runtimeManifest.dependencies, '@angular/core')
  assert.equal(lineMembers(runtime, { ...runtimeManifest, dependencies }, runtimeLock()), null)
})

test('lineMembers returns null when the runtime member versions differ', () => {
  assert.equal(lineMembers(runtime, runtimeManifest, runtimeLock({ '@angular/forms': '21.2.24' })), null)
})

test('lineMembers tolerates a missing optional runtime member', () => {
  const dependencies = without(runtimeManifest.dependencies, '@angular/router', '@angular/forms')
  const result = lineMembers(runtime, { ...runtimeManifest, dependencies }, runtimeLock())
  assert.deepEqual(result.members.map(member => member.name), RUNTIME_MEMBERS.filter(name => !['@angular/router', '@angular/forms'].includes(name)))
  assert.equal(result.version, '21.2.25')
})
