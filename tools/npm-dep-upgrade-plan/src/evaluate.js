import { findMinimumSafeVersion } from './strategies.js'
import { consumerKey, selectWithinRangeChoices } from './coverage.js'

export function evaluateFindings(rows, versionsByPackage) {
  return rows.flatMap((row) => {
    const data = versionsByPackage.get(row.package)
    const registry = Array.isArray(data) ? { versions: data } : data || { versions: [] }
    const minimumSafeVersion = findMinimumSafeVersion(row, registry.versions)
    const releaseTimes = registry.releaseTimes
    const minimumSafeVersionReleasedAt = (minimumSafeVersion && (releaseTimes instanceof Map ? releaseTimes.get(minimumSafeVersion) : releaseTimes?.[minimumSafeVersion])) || null
    const locations = new Set(row.requirements.flatMap(r => r.directDependents.map(d => d.targetLocation)))
    return [...locations].map((targetLocation) => {
      const choices = selectWithinRangeChoices(row, targetLocation, registry.versions)
      const consumers = new Set(row.requirements.flatMap(r => r.directDependents.filter(d => d.targetLocation === targetLocation).map(consumerKey)))
      const covered = new Set(choices.flatMap(c => c.affectedConsumers.map(consumerKey)))
      return { package: row.package, version: row.version, targetLocation, severity: row.severity, minimumSafeVersion, minimumSafeVersionReleasedAt, resolution: !covered.size ? 'none' : covered.size === consumers.size ? 'complete' : 'partial', choices }
    })
  })
}
