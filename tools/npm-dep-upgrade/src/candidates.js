import semver from 'semver'
import { stableVersion, normalizeTimestamp } from './registry.js'
import { fail } from './errors.js'
import { DAY_MS } from './model.js'

export function selectCandidate(item, requirements, catalog, advisories, nowMs) {
  if (!requirements.length || requirements.some(r => !semver.validRange(r))) fail('UNSUPPORTED_REQUIREMENT', 'selection', 'Unsupported original requirement')
  const ageCutoff = nowMs - (catalog.minAgeDays || 7) * DAY_MS
  const cutoff = catalog.cutoffMs == null ? ageCutoff : Math.min(ageCutoff, catalog.cutoffMs)
  const selected = [...catalog.versions].filter(stableVersion).sort(semver.rcompare).find((v) => {
    const timestamp = normalizeTimestamp(catalog.releaseTimes.get(v))
    return timestamp && Date.parse(timestamp) <= cutoff && semver.gt(v, item.version) && semver.gte(v, item.minimumSafeVersion) && requirements.every(r => semver.satisfies(v, r)) && advisories.every(a => !semver.satisfies(v, a.range, { includePrerelease: true }))
  })
  if (!selected) fail('NO_CANDIDATE', 'selection', 'No eligible safe, old-enough candidate within all original requirements')
  return { version: selected, releasedAt: catalog.releaseTimes.get(selected) }
}
