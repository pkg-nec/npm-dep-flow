import { ago, leaf } from './catalog.js'
import { fakeNx } from '../helpers/nx.js'

export const cli = '@angular/cli', build = '@angular/build', core = '@angular-devkit/core'
export const mid = 'e2e-tc-mid', kid = 'e2e-tc-kid', other = 'e2e-tc-other'
export const current = '20.0.0', next = '20.0.1'

const entry = (name, version, dependencies, days, seed = true) => ({ manifest: leaf(name, version, dependencies ? { dependencies } : {}), releasedAt: ago(days), seed })

// The real webapp shape: exact-pinned @angular/cli and @angular/build in devDependencies plus an @angular-devkit/core
// override. @angular/build pins mid, which pins the vulnerable kid two levels below the toolchain; the next toolchain
// patch brings a mid that depends on the fixed kid (or, with `withinRange`, drops kid and leaves a second root consumer
// whose caret range a within-range action must raise).
export function toolchain({ migrations = false, withinRange = false } = {}) {
  const root = withinRange ? { dependencies: { [other]: '^1.0.0' } } : {}
  return {
    manifest: { name: 'e2e-app', version: '1.0.0', private: true, ...root, devDependencies: { [cli]: current, [build]: current, nx: '1.0.0' }, overrides: { [core]: current } },
    targets: [], advisories: [{ name: kid, range: '<1.0.1', id: 30001 }],
    packages: {
      [cli]: { [current]: entry(cli, current, { [core]: current }, 100), [next]: entry(cli, next, { [core]: next }, 30, false) },
      [build]: { [current]: entry(build, current, { [core]: current, [mid]: '1.0.0' }, 100), [next]: entry(build, next, { [core]: next, [mid]: '1.0.1' }, 30, false) },
      [core]: { [current]: entry(core, current, null, 100), [next]: entry(core, next, null, 30, false) },
      [mid]: { '1.0.0': entry(mid, '1.0.0', { [kid]: '1.0.0' }, 100), '1.0.1': entry(mid, '1.0.1', withinRange ? null : { [kid]: '1.0.1' }, 30, false) },
      [kid]: { '1.0.0': entry(kid, '1.0.0', null, 100), '1.0.1': entry(kid, '1.0.1', null, 30, false) },
      ...(withinRange ? { [other]: { '1.0.0': entry(other, '1.0.0', { [kid]: '^1.0.0' }, 100) } } : {}),
      nx: fakeNx({ migrations }),
    },
  }
}
