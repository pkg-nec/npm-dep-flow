import semver from 'semver'
import { compareRows } from './model.js'

export function filterRows(rows, { all = false, major = null, range = null } = {}) {
  return rows.filter(row => (all || semver.prerelease(row.version) === null)
    && (major === null || semver.major(row.version) === major)
    && (range === null || semver.satisfies(row.version, range, { includePrerelease: all }))).sort(compareRows)
}
