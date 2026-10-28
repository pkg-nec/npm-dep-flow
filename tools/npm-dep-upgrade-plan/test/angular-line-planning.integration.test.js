import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { resolveChoices } from '../src/resolver.js'
import { ANGULAR_LINES } from '../src/angular-lines.js'
import { planLineChoices } from '../src/angular-line-planning.js'

const day = 86400000
const ago = days => new Date(Date.now() - days * day).toISOString()
const leaf = (name, version, dependencies = {}) => ({ name, version, main: 'index.js', dependencies })
const entry = (name, version, dependencies, days, seed = true) => ({ manifest: leaf(name, version, dependencies), releasedAt: ago(days), seed })

// The root pins @angular/cli and @angular/build at 1.0.0 and depends on p; all three pin the vulnerable kid@1.0.0.
// The 1.0.1 releases of the members and of p depend on the safe kid@1.0.1.
const p101 = entry('p', '1.0.1', { kid: '1.0.1' }, 40, false)
const packages = {
  manifest: { name: 'e2e-app', version: '1.0.0', private: true, dependencies: { p: '^1.0.0' }, devDependencies: { '@angular/cli': '1.0.0', '@angular/build': '1.0.0' } },
  targets: [], advisories: [],
  packages: {
    'kid': { '1.0.0': entry('kid', '1.0.0', {}, 100), '1.0.1': entry('kid', '1.0.1', {}, 50, false) },
    'p': { '1.0.0': entry('p', '1.0.0', { kid: '1.0.0' }, 100), '1.0.1': p101 },
    '@angular/cli': { '1.0.0': entry('@angular/cli', '1.0.0', { kid: '1.0.0' }, 100), '1.0.1': entry('@angular/cli', '1.0.1', { kid: '1.0.1' }, 40, false) },
    '@angular/build': { '1.0.0': entry('@angular/build', '1.0.0', { kid: '1.0.0' }, 100), '1.0.1': entry('@angular/build', '1.0.1', { kid: '1.0.1' }, 40, false) },
  },
}
const consumer = location => ({ location, requestedName: 'kid', type: 'dependencies' })
const row = {
  package: 'kid', version: '1.0.0', severity: 'high', advisories: [{ range: '<1.0.1' }],
  requirements: [{ declaredRequirement: '1.0.0', directDependents: [['@angular/cli', '1.0.0'], ['@angular/build', '1.0.0'], ['p', '1.0.0']].map(([name, version]) => ({ name, version, location: `node_modules/${name}`, requestedName: 'kid', type: 'dependencies', targetLocation: 'node_modules/kid' })) }],
}
const parentChoice = { strategy: 'upgrade-via-parent-dependency', targetPackage: 'p', targetLocation: 'node_modules/p', currentVersion: '1.0.0', targetVersion: '1.0.1', affectedConsumers: [consumer('node_modules/p')] }
const upstream = {
  nodes: new Map([['', { location: '', name: 'e2e-app', version: '1.0.0' }], ...['@angular/cli', '@angular/build', 'p'].map(name => [`node_modules/${name}`, { location: `node_modules/${name}`, name, version: '1.0.0' }])]),
  edges: ['@angular/cli', '@angular/build', 'p'].map(name => ({ from: '', to: `node_modules/${name}` })),
}

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) {
  test(`a toolchain bump joins an existing parent choice through the real resolver: ${npmCli}`, async (t) => {
    const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
    const f = await createProject(packages, { npmCli, installed: false }, t)
    const [manifestBytes, lockBytes] = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name))))
    const catalogs = {
      '@angular/cli': { versions: ['1.0.0', '1.0.1'], releaseTimes: new Map(), fetchedAt: new Date().toISOString() },
      'p': { versions: ['1.0.0', '1.0.1'], releaseTimes: new Map([['1.0.1', p101.releasedAt]]), fetchedAt: new Date().toISOString() },
    }
    const adapters = {
      readUpstream: async () => upstream,
      readCatalog: async name => catalogs[name],
      resolveChoices: (project, item, choices, options) => resolveChoices(project, item, choices, { ...options, env: f.env }),
    }
    const finding = { package: 'kid', version: '1.0.0', targetLocation: 'node_modules/kid', resolution: 'partial', choices: [parentChoice] }
    await planLineChoices({ line: ANGULAR_LINES[0], finding, row, project: { root: f.root, manifestBytes, lockBytes }, options: {}, controls: {}, adapters })
    assert.deepEqual(finding.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`), ['upgrade-angular-toolchain:@angular/cli@1.0.1', 'upgrade-via-parent-dependency:p@1.0.1'])
    assert.deepEqual(finding.choices[0].affectedConsumers, [consumer('node_modules/@angular/build'), consumer('node_modules/@angular/cli')])
    assert.equal(finding.resolution, 'complete')
    assert.deepEqual(await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name)))), [manifestBytes, lockBytes], 'the project files are never modified')
  })
}

// Both lines: the root pins the runtime at 2.0.0 and the toolchain at 1.0.0, with the real peer shape (runtime
// members peer exactly on each other, @angular/build peers on `^2.0.0` runtime ranges). @angular/core and
// @angular/cli pin the vulnerable kid@1.0.0; their next releases pin kid@1.0.1.
const RUNTIME_PEERS = {
  '@angular/common': ['@angular/core'], '@angular/compiler': [], '@angular/compiler-cli': ['@angular/compiler'], '@angular/core': ['@angular/compiler'],
  '@angular/forms': ['@angular/core', '@angular/common', '@angular/platform-browser'], '@angular/platform-browser': ['@angular/core', '@angular/common'],
  '@angular/router': ['@angular/core', '@angular/common', '@angular/platform-browser'],
}
const runtimeLine = ANGULAR_LINES.find(line => line.key === 'runtime')
const runtimeMember = (name, version) => ({
  manifest: { ...leaf(name, version, name === '@angular/core' ? { kid: version === '2.0.0' ? '1.0.0' : '1.0.1' } : {}), peerDependencies: Object.fromEntries(RUNTIME_PEERS[name].map(peer => [peer, version])) },
  releasedAt: ago(version === '2.0.0' ? 100 : 40), seed: version === '2.0.0',
})
const buildPeers = { peerDependencies: Object.fromEntries(['@angular/core', '@angular/compiler', '@angular/compiler-cli', '@angular/platform-browser'].map(name => [name, '^2.0.0'])) }
const bothLines = {
  manifest: {
    name: 'e2e-app', version: '1.0.0', private: true,
    dependencies: Object.fromEntries(runtimeLine.members.filter(name => name !== '@angular/compiler-cli').map(name => [name, '2.0.0'])),
    devDependencies: { '@angular/compiler-cli': '2.0.0', '@angular/cli': '1.0.0', '@angular/build': '1.0.0' },
  },
  targets: [], advisories: [],
  packages: {
    'kid': { '1.0.0': entry('kid', '1.0.0', {}, 100), '1.0.1': entry('kid', '1.0.1', {}, 50, false) },
    ...Object.fromEntries(runtimeLine.members.map(name => [name, { '2.0.0': runtimeMember(name, '2.0.0'), '2.0.1': runtimeMember(name, '2.0.1') }])),
    '@angular/cli': { '1.0.0': entry('@angular/cli', '1.0.0', { kid: '1.0.0' }, 100), '1.0.1': entry('@angular/cli', '1.0.1', { kid: '1.0.1' }, 40, false) },
    '@angular/build': {
      '1.0.0': { manifest: { ...leaf('@angular/build', '1.0.0'), ...buildPeers }, releasedAt: ago(100), seed: true },
      '1.0.1': { manifest: { ...leaf('@angular/build', '1.0.1'), ...buildPeers }, releasedAt: ago(40), seed: false },
    },
  },
}
const bothRow = {
  package: 'kid', version: '1.0.0', severity: 'high', advisories: [{ range: '<1.0.1' }],
  requirements: [{ declaredRequirement: '1.0.0', directDependents: [['@angular/cli', '1.0.0'], ['@angular/core', '2.0.0']].map(([name, version]) => ({ name, version, location: `node_modules/${name}`, requestedName: 'kid', type: 'dependencies', targetLocation: 'node_modules/kid' })) }],
}
const bothUpstream = {
  nodes: new Map([['', { location: '', name: 'e2e-app', version: '1.0.0' }], ['node_modules/@angular/cli', { location: 'node_modules/@angular/cli', name: '@angular/cli', version: '1.0.0' }], ['node_modules/@angular/core', { location: 'node_modules/@angular/core', name: '@angular/core', version: '2.0.0' }]]),
  edges: ['@angular/cli', '@angular/core'].map(name => ({ from: '', to: `node_modules/${name}` })),
}

for (const npmCli of [process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI, process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI].filter(Boolean)) {
  test(`a finding gains a toolchain and then a runtime choice through the real resolver: ${npmCli}`, async (t) => {
    const { createProject } = await import('../../npm-dep-upgrade/test/e2e/helpers/project.js')
    const f = await createProject(bothLines, { npmCli, installed: false }, t)
    const [manifestBytes, lockBytes] = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name))))
    const fetchedAt = { '@angular/cli': new Date(Date.now() - 60000).toISOString(), '@angular/core': new Date(Date.now() - 120000).toISOString() }
    const catalogs = {
      '@angular/cli': { versions: ['1.0.0', '1.0.1'], releaseTimes: new Map(), fetchedAt: fetchedAt['@angular/cli'] },
      '@angular/core': { versions: ['2.0.0', '2.0.1'], releaseTimes: new Map(), fetchedAt: fetchedAt['@angular/core'] },
    }
    const resolved = []
    const adapters = {
      readUpstream: async () => bothUpstream,
      readCatalog: async name => catalogs[name],
      resolveChoices: (project, item, choices, options) => {
        resolved.push(choices.map(c => c.strategy))
        return resolveChoices(project, item, choices, { ...options, env: f.env })
      },
    }
    const finding = { package: 'kid', version: '1.0.0', targetLocation: 'node_modules/kid', resolution: 'none', choices: [] }
    const project = { root: f.root, manifestBytes, lockBytes }
    const freshness = []
    for (const line of ANGULAR_LINES) freshness.push((await planLineChoices({ line, finding, row: bothRow, project, options: {}, controls: {}, adapters })).freshAt)
    assert.deepEqual(finding.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`), ['upgrade-angular-toolchain:@angular/cli@1.0.1', 'upgrade-angular-runtime:@angular/core@2.0.1'])
    assert.deepEqual(finding.choices[0].affectedConsumers, [consumer('node_modules/@angular/cli')])
    assert.deepEqual(finding.choices[1].affectedConsumers, [consumer('node_modules/@angular/core')])
    assert.equal(finding.resolution, 'complete')
    assert.deepEqual(resolved.at(-1), ['upgrade-angular-toolchain', 'upgrade-angular-runtime'], 'the runtime search keeps the toolchain choice first')
    assert.deepEqual(freshness, [Date.parse(fetchedAt['@angular/cli']), Date.parse(fetchedAt['@angular/core'])])
    assert.deepEqual(await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name)))), [manifestBytes, lockBytes], 'the project files are never modified')
  })
}
