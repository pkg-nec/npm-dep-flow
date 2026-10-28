import { ago, leaf } from './catalog.js'
import { RUNTIME, fakeNx } from '../helpers/nx.js'

export { RUNTIME }
export const core = '@angular/core', compilerCli = '@angular/compiler-cli', dynamic = '@angular/platform-browser-dynamic'
export const cli = '@angular/cli', build = '@angular/build', devkit = '@angular-devkit/core'
export const mid = 'e2e-rt-mid', kid = 'e2e-rt-kid', toolMid = 'e2e-rt-tool-mid'
export const current = '20.0.0', next = '20.0.1'

const RXJS = '^6.5.3 || ^7.4.0', TYPESCRIPT = '>=5.8 <5.9'
// The peers of the real Angular 20 packages: runtime members peer on exact versions of each other, so npm can only move
// them together, and @angular/build peers on `^` ranges of the runtime (core and platform-browser optional).
const PEERS = {
  '@angular/common': { [core]: 'exact', rxjs: RXJS },
  '@angular/compiler': {},
  '@angular/compiler-cli': { '@angular/compiler': 'exact', 'typescript': TYPESCRIPT },
  '@angular/core': { '@angular/compiler': 'exact', 'rxjs': RXJS },
  '@angular/forms': { [core]: 'exact', '@angular/common': 'exact', '@angular/platform-browser': 'exact', 'rxjs': RXJS },
  '@angular/platform-browser': { [core]: 'exact', '@angular/common': 'exact' },
  '@angular/router': { [core]: 'exact', '@angular/common': 'exact', '@angular/platform-browser': 'exact', 'rxjs': RXJS },
  '@angular/platform-browser-dynamic': { [core]: 'exact', '@angular/common': 'exact', '@angular/compiler': 'exact', '@angular/platform-browser': 'exact' },
}
const OPTIONAL = { '@angular/core': { '@angular/compiler': { optional: true } } }
const BUILD_PEERS = {
  peerDependencies: { ...Object.fromEntries(['@angular/compiler', compilerCli, core, '@angular/platform-browser'].map(name => [name, '^20.0.0'])), typescript: TYPESCRIPT },
  peerDependenciesMeta: { [core]: { optional: true }, '@angular/platform-browser': { optional: true } },
}

const release = (manifest, days, seed = true) => ({ manifest, releasedAt: ago(days), seed })
const versionsOf = make => ({ [current]: release(make(current), 100), [next]: release(make(next), 30, false) })
const angular = (name, version, dependencies = {}) => leaf(name, version, {
  dependencies,
  peerDependencies: Object.fromEntries(Object.entries(PEERS[name]).map(([peer, range]) => [peer, range === 'exact' ? version : range])),
  ...(OPTIONAL[name] ? { peerDependenciesMeta: OPTIONAL[name] } : {}),
})
const fixed = version => (version === current ? '1.0.0' : '1.0.1')

// The webapp's runtime shape beside its toolchain: the seven runtime members exact-pinned (compiler-cli in
// devDependencies, the rest in dependencies), the toolchain pair exact-pinned in devDependencies, an @angular-devkit/core
// override and a stale @angular/platform-browser-dynamic override (no lockfile entry, nothing depends on it).
// @angular/core pins mid, which pins the vulnerable kid two levels below the runtime; the next runtime patch brings a
// mid on the fixed kid. With `both`, @angular/build also reaches kid through toolMid, fixed by the next toolchain patch,
// so one finding needs both lines. `range` declares that member with `^` (the fixture nx then writes the exact version; real nx behavior for ranges is unverified); `nx` selects the fake nx variant.
export function runtime({ nx = {}, both = false, range, pbdOverride = true } = {}) {
  const dependencies = Object.fromEntries(RUNTIME.filter(name => name !== compilerCli).map(name => [name, name === range ? `^${current}` : current]))
  const overrides = { [devkit]: current, ...(pbdOverride ? { [dynamic]: current } : {}) }
  const manifest = {
    name: 'e2e-app', version: '1.0.0', private: true,
    dependencies: { ...dependencies, rxjs: '~7.8.0' },
    devDependencies: { [compilerCli]: range === compilerCli ? `^${current}` : current, [cli]: current, [build]: current, nx: '1.0.0', typescript: '~5.8.2' },
    overrides,
  }
  const tool = (name, version) => leaf(name, version, {
    dependencies: { [devkit]: version, ...(both && name === build ? { [toolMid]: fixed(version) } : {}) },
    ...(name === build ? BUILD_PEERS : {}),
  })
  return {
    manifest, targets: [], advisories: [{ name: kid, range: '<1.0.1', id: 40001 }],
    packages: {
      ...Object.fromEntries(RUNTIME.map(name => [name, versionsOf(version => angular(name, version, name === core ? { [mid]: fixed(version) } : {}))])),
      [dynamic]: versionsOf(version => angular(dynamic, version)),
      [cli]: versionsOf(version => tool(cli, version)),
      [build]: versionsOf(version => tool(build, version)),
      [devkit]: versionsOf(version => leaf(devkit, version)),
      [mid]: { '1.0.0': release(leaf(mid, '1.0.0', { dependencies: { [kid]: '1.0.0' } }), 100), '1.0.1': release(leaf(mid, '1.0.1', { dependencies: { [kid]: '1.0.1' } }), 30, false) },
      [toolMid]: { '1.0.0': release(leaf(toolMid, '1.0.0', { dependencies: { [kid]: '1.0.0' } }), 100), '1.0.1': release(leaf(toolMid, '1.0.1', { dependencies: { [kid]: '1.0.1' } }), 30, false) },
      [kid]: { '1.0.0': release(leaf(kid, '1.0.0'), 100), '1.0.1': release(leaf(kid, '1.0.1'), 30, false) },
      rxjs: { '7.8.2': release(leaf('rxjs', '7.8.2'), 100) },
      typescript: { '5.8.3': release(leaf('typescript', '5.8.3'), 100) },
      nx: fakeNx(nx),
    },
  }
}
