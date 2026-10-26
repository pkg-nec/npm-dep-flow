import semver from 'semver'
import { consumerKey } from './coverage.js'
import { stableVersion, normalizeTimestamp } from './registry.js'
import { fail } from './errors.js'
import { DAY_MS, PARENT_STRATEGY } from './model.js'

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// An alias declaration (npm:name@range) constrains the real package by the range after the last '@'.
function rangeOf(spec) {
  const range = typeof spec === 'string' && spec.startsWith('npm:') ? spec.slice(spec.lastIndexOf('@') + 1) : spec
  return typeof range === 'string' ? semver.validRange(range) : null
}

// Every incoming declaration on the ancestor installation constrains the release, including edges from unrelated consumers.
export function parentRanges(choice, graph) {
  const ranges = graph.edges.filter(edge => edge.to === choice.targetLocation).map(edge => rangeOf(edge.rawSpec))
  if (!ranges.length || ranges.includes(null)) fail('UNSUPPORTED_REQUIREMENT', 'selection', 'Unsupported incoming requirement on the ancestor installation')
  return ranges
}

// Parent actions run first (ancestor level ascending, then original location/name/version), then within-range actions.
export function orderChoices(item, evidence) {
  const entries = item.choices.map((choice, index) => ({ choice, index, level: 0 }))
  for (const entry of entries) {
    const { choice } = entry
    const incoming = choice.affectedConsumers.map(consumer => evidence.incoming.find(edge => consumerKey(edge) === consumerKey(consumer)))
    if (incoming.some(edge => !edge)) fail('INVALID_PLAN', 'evidence', 'Choice consumer does not reference the selected installation')
    if (choice.strategy !== PARENT_STRATEGY) continue
    const ancestor = evidence.graph.nodes.get(choice.targetLocation)
    if (!ancestor || ancestor.name !== choice.targetPackage || ancestor.version !== choice.currentVersion) fail('STALE_RECOMMENDATION', 'evidence', 'Ancestor installation changed; recommendation is stale')
    const locations = incoming.map(edge => edge.from)
    if (locations.includes(choice.targetLocation)) entry.level = 1
    else if (evidence.graph.edges.some(edge => edge.from === choice.targetLocation && locations.includes(edge.to))) entry.level = 2
    else fail('INVALID_PLAN', 'evidence', 'Parent choice is outside two ancestor levels of the selected installation')
  }
  const rank = entry => (entry.level === 0 ? Infinity : entry.level)
  return entries.sort((a, b) => (rank(a) === rank(b) ? (a.level === 0 ? a.index - b.index : compareText(a.choice.targetLocation, b.choice.targetLocation) || compareText(a.choice.targetPackage, b.choice.targetPackage) || semver.compare(a.choice.targetVersion, b.choice.targetVersion)) : rank(a) < rank(b) ? -1 : 1))
}

// The executor never substitutes another ancestor release: the planned one must still be eligible or the plan is stale.
export function selectParentRelease(choice, ranges, catalog, advisories, nowMs) {
  const version = choice.targetVersion
  if (!catalog.versions.includes(version) || !stableVersion(version)) fail('NO_CANDIDATE', 'selection', 'Planned parent release is not in the registry catalog')
  const releasedAt = normalizeTimestamp(catalog.releaseTimes.get(version))
  if (!releasedAt) fail('RELEASE_AGE', 'selection', 'Planned parent release has an unverifiable release age')
  const ageCutoff = nowMs - (catalog.minAgeDays || 7) * DAY_MS
  const cutoff = catalog.cutoffMs == null ? ageCutoff : Math.min(ageCutoff, catalog.cutoffMs)
  if (Date.parse(releasedAt) > cutoff) fail('RELEASE_AGE', 'selection', 'Planned parent release has insufficient release age')
  if (!ranges.every(range => semver.satisfies(version, range))) fail('UNSUPPORTED_REQUIREMENT', 'selection', 'Planned parent release violates an incoming requirement on the ancestor')
  if (advisories.some(advisory => semver.satisfies(version, advisory.range, { includePrerelease: true }))) fail('STALE_RECOMMENDATION', 'selection', 'Planned parent release is now vulnerable; run planning again')
  return { version, releasedAt }
}
