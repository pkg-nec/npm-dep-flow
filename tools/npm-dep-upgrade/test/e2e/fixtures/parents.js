import { ago, leaf, target } from './catalog.js'

const releases = (name, versions) => Object.fromEntries(Object.entries(versions).map(([version, [dependencies, days, seed = true]]) => [version, { manifest: leaf(name, version, dependencies ? { dependencies } : {}), releasedAt: ago(days), seed }]))
export const pb = 'e2e-pb', pc = 'e2e-pc', pd = 'e2e-pd', grand = 'e2e-grand'

// root -> pb (pins the target at 6.0.9) and root -> pc (the other consumer of the shared installation).
// pb@1.1.0 is the safe release; `pbNext` describes what that release does with the target.
export function parents({ pcSpec = '^6.0.8', pbNext = { [target]: '6.0.12' }, extra = {}, root = {} } = {}) {
  return {
    manifest: { name: 'e2e-app', version: '1.0.0', private: true, dependencies: { [pb]: '^1.0.0', [pc]: '^1.0.0', ...root } },
    targets: [], advisories: [{ name: target, range: '<6.0.10', id: 10001 }],
    packages: {
      [target]: releases(target, { '6.0.9': [null, 100], '6.0.12': [null, 40, false] }),
      [pb]: releases(pb, { '1.0.1': [{ [target]: '6.0.9' }, 90], '1.1.0': [pbNext, 30, false] }),
      [pc]: releases(pc, { '1.0.0': [{ [target]: pcSpec }, 90] }),
      ...extra,
    },
  }
}
