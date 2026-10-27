import semver from 'semver'
import { stableVersion, normalizeTimestamp } from './registry.js'
import { fail } from './errors.js'
import { DAY_MS } from './model.js'

export const ALLOWLIST = ['@angular/cli', '@angular/build', '@angular-devkit/core', '@angular-devkit/schematics', '@schematics/angular', '@angular-devkit/architect']
const ARCHITECT = '@angular-devkit/architect'
const DEVKIT_CORE = '@angular-devkit/core'
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']

// The planned release is used while it is eligible; otherwise the lowest newer eligible release of the same major.
// Only the publication time of @angular/cli (the catalog's release times) decides release age.
export function selectToolchainRelease(choice, catalog, advisories, nowMs) {
  const planned = choice.targetVersion
  if (!catalog.versions.includes(planned) || !stableVersion(planned)) fail('NO_CANDIDATE', 'selection', 'Planned toolchain release is not in the registry catalog')
  const major = semver.major(choice.currentVersion)
  const ageCutoff = nowMs - (catalog.minAgeDays || 7) * DAY_MS
  const cutoff = catalog.cutoffMs == null ? ageCutoff : Math.min(ageCutoff, catalog.cutoffMs)
  const problem = (version) => {
    const releasedAt = normalizeTimestamp(catalog.releaseTimes.get(version))
    if (semver.major(version) !== major) return ['NO_CANDIDATE', 'Planned toolchain release is not in the current major']
    if (!releasedAt) return ['RELEASE_AGE', 'Planned toolchain release has an unverifiable release age']
    if (Date.parse(releasedAt) > cutoff) return ['RELEASE_AGE', 'Planned toolchain release has insufficient release age']
    if (advisories.some(advisory => semver.satisfies(version, advisory.range, { includePrerelease: true }))) return ['NO_CANDIDATE', 'Planned toolchain release is now vulnerable']
    return null
  }
  const first = problem(planned)
  if (!first) return { version: planned, releasedAt: normalizeTimestamp(catalog.releaseTimes.get(planned)) }
  const newer = [...new Set(catalog.versions)].filter(version => stableVersion(version) && semver.gt(version, planned)).sort(semver.compare).find(version => !problem(version))
  if (!newer) fail(first[0], 'selection', first[1])
  return { version: newer, releasedAt: normalizeTimestamp(catalog.releaseTimes.get(newer)) }
}

const declared = (manifest, field) => {
  const value = manifest?.[field]
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

// An object-form override pins the package at its "." key; every other key must stay as it was.
function checkNestedOverride(name, before, after, version) {
  const oldEntry = isObject(before) ? before : {}
  const newEntry = isObject(after) ? after : {}
  for (const key of new Set([...Object.keys(oldEntry), ...Object.keys(newEntry)])) {
    if (key === '.') continue
    if (Object.hasOwn(oldEntry, key) !== Object.hasOwn(newEntry, key) || JSON.stringify(oldEntry[key]) !== JSON.stringify(newEntry[key])) fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', `Unexpected change to ${key} in the override for ${name}`)
  }
  if (name !== ARCHITECT && newEntry['.'] !== version) fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', `${name} in overrides must be ${version}`)
}

// Only allowlisted toolchain packages may change, and (except architect) only to the selected version.
export function checkManifestChanges(beforeManifest, afterManifest, version) {
  for (const field of FIELDS) {
    const before = declared(beforeManifest, field)
    const after = declared(afterManifest, field)
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const unchanged = Object.hasOwn(before, name) === Object.hasOwn(after, name) && JSON.stringify(before[name]) === JSON.stringify(after[name])
      if (unchanged) continue
      if (!ALLOWLIST.includes(name)) fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', `Unexpected change to ${name} in ${field}`)
      const nested = field === 'overrides' && (isObject(before[name]) || isObject(after[name]))
      if (nested) checkNestedOverride(name, before[name], after[name], version)
      else if (name !== ARCHITECT && after[name] !== version) fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', `${name} in ${field} must be ${version}`)
    }
  }
}

// Sets overrides['@angular-devkit/core'] while keeping the file's indentation, line endings and trailing newline.
export function setDevkitOverride(manifestText, version) {
  const manifest = JSON.parse(manifestText)
  const overrides = manifest.overrides
  if (!overrides || typeof overrides !== 'object' || !Object.hasOwn(overrides, DEVKIT_CORE)) return null
  const entry = overrides[DEVKIT_CORE]
  if (entry && typeof entry === 'object') {
    if (!Object.hasOwn(entry, '.')) fail('UNSUPPORTED_OVERRIDE', 'verification', `Override for ${DEVKIT_CORE} has no "." entry`)
    entry['.'] = version
  }
  else {
    overrides[DEVKIT_CORE] = version
  }
  const newline = manifestText.includes('\r\n') ? '\r\n' : '\n'
  const indent = /\n([\t ]+)"/.exec(manifestText)?.[1]
  return JSON.stringify(manifest, null, indent).replaceAll('\n', newline) + (manifestText.endsWith('\n') ? newline : '')
}
