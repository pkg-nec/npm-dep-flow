import { ago, leaf } from './catalog.js'

export const cli = '@angular/cli', build = '@angular/build', core = '@angular-devkit/core'
export const mid = 'e2e-tc-mid', kid = 'e2e-tc-kid', other = 'e2e-tc-other'
export const current = '20.0.0', next = '20.0.1'

const entry = (name, version, dependencies, days, seed = true) => ({ manifest: leaf(name, version, dependencies ? { dependencies } : {}), releasedAt: ago(days), seed })

// A stand-in for `nx migrate @angular/cli@<v>`: it rewrites the toolchain pair in package.json to <v> and, in the
// `migrations` variant, also writes migrations.json as a real migration with code changes would.
function fakeNx(migrations) {
  const source = `#!/usr/bin/env node
const fs = require('fs')
const [command, spec = ''] = process.argv.slice(2)
const prefix = '@angular/cli@'
if (command !== 'migrate' || !spec.startsWith(prefix)) {
  process.stderr.write('fake nx: unsupported arguments ' + process.argv.slice(2).join(' ') + '\\n')
  process.exit(2)
}
const version = spec.slice(prefix.length)
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
for (const field of ['dependencies', 'devDependencies']) for (const name of ['@angular/cli', '@angular/build']) if (manifest[field] && manifest[field][name]) manifest[field][name] = version
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\\n')
${migrations ? `fs.writeFileSync('migrations.json', JSON.stringify({ migrations: [{ package: '@angular/cli', name: 'fixture-migration', version }] }, null, 2) + '\\n')` : ''}
`
  return { '1.0.0': { manifest: { ...leaf('nx', '1.0.0'), bin: { nx: 'nx.js' } }, files: { 'nx.js': source }, releasedAt: ago(100) } }
}

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
      nx: fakeNx(migrations),
    },
  }
}
