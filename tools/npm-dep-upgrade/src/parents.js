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

// The planned release is used while it is eligible. If it no longer is (a fresh advisory, an incoming declaration
// that changed), the lowest newer eligible release is used instead; resolution then has to land on it and still
// produce the planned coverage, otherwise the plan is stale. Nothing lower than the planned release is ever chosen.
export function selectParentRelease(choice, ranges, catalog, advisories, nowMs) {
  const planned = choice.targetVersion
  if (!catalog.versions.includes(planned) || !stableVersion(planned)) fail('NO_CANDIDATE', 'selection', 'Planned parent release is not in the registry catalog')
  const ageCutoff = nowMs - (catalog.minAgeDays || 7) * DAY_MS
  const cutoff = catalog.cutoffMs == null ? ageCutoff : Math.min(ageCutoff, catalog.cutoffMs)
  const problem = (version) => {
    const releasedAt = normalizeTimestamp(catalog.releaseTimes.get(version))
    if (!releasedAt) return ['RELEASE_AGE', 'Planned parent release has an unverifiable release age']
    if (Date.parse(releasedAt) > cutoff) return ['RELEASE_AGE', 'Planned parent release has insufficient release age']
    if (!ranges.every(range => semver.satisfies(version, range))) return ['UNSUPPORTED_REQUIREMENT', 'Planned parent release violates an incoming requirement on the ancestor']
    if (advisories.some(advisory => semver.satisfies(version, advisory.range, { includePrerelease: true }))) return ['STALE_RECOMMENDATION', 'Planned parent release is now vulnerable; run planning again']
    return null
  }
  const first = problem(planned)
  if (!first) return { version: planned, releasedAt: normalizeTimestamp(catalog.releaseTimes.get(planned)) }
  const newer = [...new Set(catalog.versions)].filter(version => stableVersion(version) && semver.gt(version, planned)).sort(semver.compare).find(version => !problem(version))
  if (!newer) fail(first[0], 'selection', first[1])
  return { version: newer, releasedAt: normalizeTimestamp(catalog.releaseTimes.get(newer)) }
}
