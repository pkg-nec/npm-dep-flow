import { findMinimumSafeVersion, orderedStrategies } from './strategies.js'

function releaseTimeFor(releaseTimes, version) {
  if (!version || !releaseTimes) return null
  const releaseTime = releaseTimes instanceof Map
    ? releaseTimes.get(version)
    : releaseTimes[version]
  return typeof releaseTime === 'string' ? releaseTime : null
}

function groupTargetLocations(row) {
  const groups = new Map()
  for (const requirement of row.requirements) {
    for (const dependent of requirement.directDependents) {
      let group = groups.get(dependent.targetLocation)
      if (!group) {
        group = { targetLocation: dependent.targetLocation, declaredRequirements: new Set() }
        groups.set(dependent.targetLocation, group)
      }
      group.declaredRequirements.add(requirement.declaredRequirement)
    }
  }
  return [...groups.values()].map(group => ({
    targetLocation: group.targetLocation,
    declaredRequirements: [...group.declaredRequirements],
  }))
}

function registryDataFor(versionsByPackage, packageName) {
  const data = versionsByPackage.get(packageName)
  if (Array.isArray(data)) return { versions: data, releaseTimes: null }
  return {
    versions: Array.isArray(data?.versions) ? data.versions : [],
    releaseTimes: data?.releaseTimes ?? null,
  }
}

export function evaluateFindings(rows, versionsByPackage, strategies = orderedStrategies) {
  const ordered = [...strategies].sort((left, right) => left.order - right.order)

  return rows.flatMap(row => {
    const registry = registryDataFor(versionsByPackage, row.package)
    const minimumSafeVersion = findMinimumSafeVersion(row, registry.versions)
    const minimumSafeVersionReleasedAt = releaseTimeFor(registry.releaseTimes, minimumSafeVersion)

    return groupTargetLocations(row).map(group => {
      let strategy = null
      for (const item of ordered) {
        strategy = item.evaluate(row, group.declaredRequirements, registry.versions)
        if (strategy !== null && strategy !== undefined) break
      }

      return {
        package: row.package,
        version: row.version,
        targetLocation: group.targetLocation,
        severity: row.severity,
        minimumSafeVersion,
        minimumSafeVersionReleasedAt,
        status: strategy ? 'eligible' : 'ineligible',
        strategy,
      }
    })
  })
}
