import semver from 'semver'

const strategyId = 'update-within-declared-range'

function strictStableVersion(value) {
  const parsed = semver.parse(value)
  if (!parsed || parsed.prerelease.length > 0) return false
  const buildMetadata = value.includes('+') ? value.slice(value.indexOf('+')) : ''
  return `${parsed.format()}${buildMetadata}` === value
}

function declaredRange(row, declaredRequirement) {
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

function ineligible(reason) {
  return { id: strategyId, status: 'ineligible', reason }
}

export function updateWithinDeclaredRange(row, declaredRequirement, stableVersions) {
  const requirement = declaredRange(row, declaredRequirement)
  if (requirement === null) return ineligible('unsupported-requirement')

  const installedVersion = semver.valid(row.version)
  const vulnerableRanges = row.advisories.map(advisory => semver.validRange(advisory.range))
  if (!installedVersion || vulnerableRanges.length === 0 || vulnerableRanges.some(range => range === null)) {
    return ineligible('no-compatible-safe-version')
  }

  const candidates = [...new Set(stableVersions.filter(strictStableVersion))]
  candidates.sort((left, right) => {
    const bySemver = semver.compare(left, right)
    if (bySemver !== 0) return bySemver
    return left < right ? -1 : left > right ? 1 : 0
  })

  const minimumSafeVersion = candidates.find(candidate =>
    semver.gt(candidate, installedVersion) &&
    semver.satisfies(candidate, requirement) &&
    vulnerableRanges.every(range => !semver.satisfies(candidate, range)),
  )
  if (!minimumSafeVersion) return ineligible('no-compatible-safe-version')
  return { id: strategyId, status: 'eligible', minimumSafeVersion }
}

export const orderedStrategies = [{
  id: strategyId,
  label: 'Update within declared range',
  order: 1,
  evaluate: updateWithinDeclaredRange,
}]
