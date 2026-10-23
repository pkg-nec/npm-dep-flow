import { safeStableVersions, declaredRange } from './strategies.js'
import semver from 'semver'

export const consumerKey = consumer => JSON.stringify([consumer.location, consumer.requestedName, consumer.type])
export function selectWithinRangeChoices(row, targetLocation, catalog) {
  const consumers = new Map()
  for (const requirement of row.requirements) for (const dependent of requirement.directDependents) {
    if (dependent.targetLocation !== targetLocation) continue
    const consumer = { location: dependent.location, requestedName: dependent.requestedName, type: dependent.type }
    consumers.set(consumerKey(consumer), { consumer, range: declaredRange(row, requirement.declaredRequirement) })
  }
  const remaining = new Map([...consumers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const choices = []
  const versions = safeStableVersions(row, Array.isArray(catalog) ? catalog : catalog.versions)
  while (remaining.size) {
    let best = null
    for (const version of versions) {
      const covered = [...remaining].filter(([, item]) => item.range && semver.satisfies(version, item.range))
      if (covered.length && (!best || covered.length > best.covered.length)) best = { version, covered }
    }
    if (!best) break
    choices.push({ strategy: 'update-within-declared-range', targetPackage: row.package, targetLocation, currentVersion: row.version, targetVersion: best.version, affectedConsumers: best.covered.map(([, item]) => item.consumer) })
    for (const [key] of best.covered) remaining.delete(key)
  }
  return choices
}
