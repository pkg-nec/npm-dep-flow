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

export const grandName = 'e2e-grand', hName = 'e2e-h', pb2 = 'e2e-pb2', xName = 'e2e-x'

// root -> grand -> pb (pins the target) and root -> pc. `grandPin` pins pb exactly in grand@1.0.0, so only a newer grand can free it.
export function chain({ grandPin = false, hPin = false, withH = false, pcSpec = '^6.0.8' } = {}) {
  const s = parents({ pcSpec })
  s.manifest.dependencies = { [withH ? hName : grandName]: '^1.0.0', [pc]: '^1.0.0' }
  s.packages[grandName] = releases(grandName, {
    '1.0.0': [{ [pb]: grandPin ? '1.0.1' : '^1.0.0' }, 90],
    '1.1.0': [{ [pb]: '^1.1.0' }, 30, false],
  })
  if (withH) {
    s.packages[hName] = releases(hName, {
      '1.0.0': [{ [grandName]: hPin ? '1.0.0' : '^1.0.0' }, 90],
      '1.1.0': [{ [grandName]: '^1.1.0' }, 30, false],
    })
  }
  return s
}

// root -> grand -> {pb, pb2}: both children pin the target and only grand@1.1.0 frees them.
export function sharedGrand() {
  const s = parents()
  s.manifest.dependencies = { [grandName]: '^1.0.0', [pc]: '^1.0.0' }
  s.packages[pb2] = releases(pb2, { '1.0.1': [{ [target]: '6.0.9' }, 90], '1.1.0': [{ [target]: '6.0.12' }, 30, false] })
  s.packages[grandName] = releases(grandName, {
    '1.0.0': [{ [pb]: '1.0.1', [pb2]: '1.0.1' }, 90],
    '1.1.0': [{ [pb]: '^1.1.0', [pb2]: '^1.1.0' }, 30, false],
  })
  return s
}

// pb@1.1.0 drops its direct declaration but pulls in x, which still depends on the affected target version.
export function reintroduced() {
  return parents({
    pbNext: { [xName]: '^1.0.0' },
    extra: { [xName]: releases(xName, { '1.0.0': [{ [target]: '6.0.9' }, 90] }) },
  })
}

// pd also depends on pb and keeps it on the 1.0 line, so pb@1.1.0 violates an incoming declaration.
export function constrained() {
  const s = parents()
  s.manifest.dependencies[pd] = '^1.0.0'
  s.packages[pd] = releases(pd, { '1.0.0': [{ [pb]: '~1.0.0' }, 90] })
  return s
}

export const pxName = 'e2e-px'

// Two physical copies of pb: 2.0.0 at the top level and 1.0.1 under px. npm's named update would also move the top-level
// copy to 2.0.1, which is outside the finding, so the candidate cannot be isolated and is rejected.
export function twoAncestorCopies() {
  const s = parents()
  s.manifest.dependencies = { [pb]: '^2.0.0', [pxName]: '^1.0.0', [pc]: '^1.0.0' }
  s.packages[pb] = releases(pb, {
    '1.0.1': [{ [target]: '6.0.9' }, 90],
    '1.1.0': [{ [target]: '6.0.12' }, 30, false],
    '2.0.0': [null, 80],
    '2.0.1': [null, 60, false],
  })
  s.packages[pxName] = releases(pxName, { '1.0.0': [{ [pb]: '^1.0.0' }, 90] })
  return s
}
