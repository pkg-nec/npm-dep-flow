import semver from 'semver'

const strategyId = 'update-within-declared-range'

function strictStableVersion(value) {
  const parsed = semver.parse(value)
  if (!parsed || parsed.prerelease.length > 0) return false
  const buildMetadata = value.includes('+') ? value.slice(value.indexOf('+')) : ''
  return `${parsed.format()}${buildMetadata}` === value
}

export function declaredRange(row, declaredRequirement) {
  if (typeof declaredRequirement !== 'string') return null

  let range = declaredRequirement
  if (range.startsWith('npm:')) {
    const alias = range.slice('npm:'.length)
    const separator = alias.lastIndexOf('@')
    if (separator <= 0 || alias.slice(0, separator) !== row.package) return null
    range = alias.slice(separator + 1)
  }

  if (range.length === 0 || semver.validRange(range) === null) return null
  return range
}

export function safeStableVersions(row, stableVersions) {
  const installedVersion = semver.valid(row.version)
  const vulnerableRanges = row.advisories.map(advisory => semver.validRange(advisory.range))
  if (!installedVersion || vulnerableRanges.length === 0 || vulnerableRanges.some(range => range === null)) {
    return []
  }

  const candidates = [...new Set(stableVersions.filter(strictStableVersion))]
  candidates.sort((left, right) => {
    const bySemver = semver.compare(left, right)
    if (bySemver !== 0) return bySemver
    return Number(left > right) - Number(left < right)
  })

  return candidates.filter(candidate =>
    semver.gt(candidate, installedVersion)
    && vulnerableRanges.every(range => !semver.satisfies(candidate, range)),
  )
}

export function findMinimumSafeVersion(row, stableVersions) {
  return safeStableVersions(row, stableVersions)[0] ?? null
}

export function updateWithinDeclaredRange(row, declaredRequirements, stableVersions) {
  const requirements = Array.isArray(declaredRequirements)
    ? declaredRequirements
    : [declaredRequirements]
  if (requirements.length === 0) return null

  const ranges = requirements.map(requirement => declaredRange(row, requirement))
  if (ranges.some(range => range === null)) return null

  const targetVersion = safeStableVersions(row, stableVersions).find(candidate =>
    ranges.every(range => semver.satisfies(candidate, range)),
  )
  if (!targetVersion) return null

  return {
    id: strategyId,
    targetPackage: row.package,
    currentVersion: row.version,
    targetVersion,
  }
}

export const orderedStrategies = [{
  id: strategyId,
  label: 'Update within declared range',
  order: 1,
  evaluate: updateWithinDeclaredRange,
}]
