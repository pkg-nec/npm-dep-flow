import { ago, leaf } from '../fixtures/catalog.js'

export const RUNTIME = ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router']
// The Angular lines as `nx migrate <package>@<v>` treats them: the package argument names the line, and each member the
// root declares moves to <v>. Kept here independently of the tools' own registries.
const LINES = {
  '@angular/cli': { members: ['@angular/cli', '@angular/build'], overrides: ['@angular-devkit/core'] },
  '@angular/core': { members: RUNTIME, overrides: ['@angular/platform-browser-dynamic'] },
}

// A stand-in for `nx migrate <package>@<v>` served by the local registry as nx@1.0.0. It writes the exact
// version (real nx behavior for a member declared with a range is an unverified assumption) for every root-declared member of the named line in the field that declares it and leaves `overrides` alone.
// Variants: `migrations` also writes migrations.json as a real migration with code changes would; `overrides` also sets
// the line's overrides that exist; `extra` sets further root declarations to the given versions; `keepRange` keeps a
// member's `^`/`~` operator in front of the new version.
export function fakeNx({ migrations = false, overrides = false, extra = {}, keepRange = false } = {}) {
  const config = JSON.stringify({ lines: LINES, migrations, overrides, extra, keepRange })
  const source = `#!/usr/bin/env node
const fs = require('fs')
const config = ${config}
const [command, spec = ''] = process.argv.slice(2)
const at = spec.lastIndexOf('@')
const name = at > 0 ? spec.slice(0, at) : ''
const line = Object.hasOwn(config.lines, name) ? config.lines[name] : undefined
if (command !== 'migrate' || !line) {
  process.stderr.write('fake nx: unsupported arguments ' + process.argv.slice(2).join(' ') + '\\n')
  process.exit(2)
}
const version = spec.slice(at + 1)
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const set = (dependency, value, keep) => {
  for (const field of ['dependencies', 'devDependencies']) {
    if (!manifest[field] || !Object.hasOwn(manifest[field], dependency)) continue
    manifest[field][dependency] = (keep ? (/^[~^]/.exec(manifest[field][dependency]) || [''])[0] : '') + value
  }
}
for (const member of line.members) set(member, version, config.keepRange)
for (const [dependency, value] of Object.entries(config.extra)) set(dependency, value, false)
if (config.overrides && manifest.overrides) {
  for (const override of line.overrides) {
    if (!Object.hasOwn(manifest.overrides, override)) continue
    const entry = manifest.overrides[override]
    if (entry && typeof entry === 'object') entry['.'] = version
    else manifest.overrides[override] = version
  }
}
fs.writeFileSync('package.json', JSON.stringify(manifest, null, 2) + '\\n')
if (config.migrations) fs.writeFileSync('migrations.json', JSON.stringify({ migrations: [{ package: name, name: 'fixture-migration', version }] }, null, 2) + '\\n')
`
  return { '1.0.0': { manifest: { ...leaf('nx', '1.0.0'), bin: { nx: 'nx.js' } }, files: { 'nx.js': source }, releasedAt: ago(100) } }
}
