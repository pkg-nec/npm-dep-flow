import { orderedStrategies } from './strategies.js'

export function evaluateFindings(rows, versionsByPackage, strategies = orderedStrategies) {
  const ordered = [...strategies].sort((left, right) => left.order - right.order)

  return rows.map(row => {
    const stableVersions = versionsByPackage.get(row.package) ?? []
    return {
      ...row,
      requirements: row.requirements.map(requirement => ({
        ...requirement,
        directDependents: requirement.directDependents.map(dependent => ({
          ...dependent,
          strategies: ordered.map(strategy =>
            strategy.evaluate(row, requirement.declaredRequirement, stableVersions),
          ),
        })),
      })),
    }
  })
}
