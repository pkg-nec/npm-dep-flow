import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { resolveChoices } from '../src/resolver.js'
import { planToolchainChoices } from '../src/toolchain-planning.js'

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
    await planToolchainChoices({ finding, row, project: { root: f.root, manifestBytes, lockBytes }, options: {}, controls: {}, adapters })
    assert.deepEqual(finding.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`), ['upgrade-angular-toolchain:@angular/cli@1.0.1', 'upgrade-via-parent-dependency:p@1.0.1'])
    assert.deepEqual(finding.choices[0].affectedConsumers, [consumer('node_modules/@angular/build'), consumer('node_modules/@angular/cli')])
    assert.equal(finding.resolution, 'complete')
    assert.deepEqual(await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(path.join(f.root, name)))), [manifestBytes, lockBytes], 'the project files are never modified')
  })
}
