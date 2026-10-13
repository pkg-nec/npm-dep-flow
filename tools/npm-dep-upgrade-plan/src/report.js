import semver from 'semver'

const severityOrder = new Map([
  ['critical', 0],
  ['high', 1],
  ['moderate', 2],
  ['low', 3],
  ['info', 4],
])

const strategyLabels = new Map([
  ['update-within-declared-range', 'Update within declared range'],
])

function compareText(left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function compareVersion(left, right) {
  if (semver.valid(left) && semver.valid(right)) {
    return semver.compare(left, right) || compareText(left, right)
  }
  return compareText(left, right)
}

function compareDependents(left, right) {
  return compareText(left.name, right.name) ||
    compareVersion(left.version, right.version) ||
    compareText(left.location, right.location) ||
    compareText(left.targetLocation, right.targetLocation) ||
    compareText(left.type, right.type) ||
    compareText(left.requestedName, right.requestedName)
}

function compareDependentLists(left, right) {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const comparison = compareDependents(left[index], right[index])
    if (comparison !== 0) return comparison
  }
  return left.length - right.length
}

function compareRequirements(left, right) {
  return compareText(left.declaredRequirement, right.declaredRequirement) ||
    compareDependentLists(left.directDependents, right.directDependents)
}

function compareRows(left, right) {
  return (severityOrder.get(left.severity) ?? Number.MAX_SAFE_INTEGER) -
    (severityOrder.get(right.severity) ?? Number.MAX_SAFE_INTEGER) ||
    compareText(left.package, right.package) ||
    compareVersion(left.version, right.version) ||
    compareText(JSON.stringify(left), JSON.stringify(right))
}

export function sortFindings(rows) {
  return rows.map(row => ({
    ...row,
    requirements: row.requirements.map(requirement => ({
      ...requirement,
      directDependents: [...requirement.directDependents].sort(compareDependents),
    })).sort(compareRequirements),
  })).sort(compareRows)
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/([*_`])/g, '\\$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n]/g, ' ')
}

function safeAdvisoryUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return encodeURI(url.href).replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return null
  }
}

function renderAdvisory(advisory) {
  const id = escapeMarkdown(advisory.id)
  const title = escapeMarkdown(advisory.title)
  const range = escapeMarkdown(advisory.range)
  const url = safeAdvisoryUrl(advisory.url)
  const label = url ? `[${id}](${url}) ${title}` : `(${id}) ${title}`
  return `${label} (${range})`
}

function displayLocation(location) {
  return location === '' ? '(project root)' : location
}

function renderStrategy(strategy) {
  const label = escapeMarkdown(strategyLabels.get(strategy.id) ?? strategy.id)
  if (strategy.status === 'eligible') {
    return `${label}: eligible; minimum safe version ${escapeMarkdown(strategy.minimumSafeVersion)}`
  }
  return `${label}: ineligible (${escapeMarkdown(strategy.reason)})`
}

export function renderMarkdown(rows) {
  const orderedRows = sortFindings(rows)
  if (orderedRows.length === 0) {
    return '# npm-dep-upgrade-plan\n\nNo vulnerable package findings.\n'
  }

  const output = [
    '# npm-dep-upgrade-plan',
    '',
    '| Package | Installed | Severity | Advisories | Requirement | Direct dependent | Dependent location | Target location | Remediation strategies |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const row of orderedRows) {
    const advisories = row.advisories.map(renderAdvisory).join('<br>')
    for (const requirement of row.requirements) {
      for (const dependent of requirement.directDependents) {
        const identity = `${dependent.name}@${dependent.version} (${dependent.type}; requested ${dependent.requestedName})`
        const strategies = dependent.strategies.length > 0
          ? dependent.strategies.map(renderStrategy).join('<br>')
          : 'No remediation strategies registered'
        output.push(`| ${escapeMarkdown(row.package)} | ${escapeMarkdown(row.version)} | ${escapeMarkdown(row.severity)} | ${advisories} | ${escapeMarkdown(requirement.declaredRequirement)} | ${escapeMarkdown(identity)} | ${escapeMarkdown(displayLocation(dependent.location))} | ${escapeMarkdown(displayLocation(dependent.targetLocation))} | ${strategies} |`)
      }
    }
  }

  return `${output.join('\n')}\n`
}

function renderStrategyJson(strategy) {
  return strategy.status === 'eligible'
    ? { id: strategy.id, status: strategy.status, minimumSafeVersion: strategy.minimumSafeVersion }
    : { id: strategy.id, status: strategy.status, reason: strategy.reason }
}

export function renderJson(rows, auditedAt) {
  const orderedRows = sortFindings(rows).map(row => ({
    package: row.package,
    version: row.version,
    severity: row.severity,
    advisories: row.advisories.map(advisory => ({
      id: advisory.id,
      title: advisory.title,
      url: advisory.url,
      severity: advisory.severity,
      range: advisory.range,
    })),
    requirements: row.requirements.map(requirement => ({
      declaredRequirement: requirement.declaredRequirement,
      directDependents: requirement.directDependents.map(dependent => ({
        name: dependent.name,
        version: dependent.version,
        location: dependent.location,
        targetLocation: dependent.targetLocation,
        type: dependent.type,
        requestedName: dependent.requestedName,
        strategies: dependent.strategies.map(renderStrategyJson),
      })),
    })),
  }))
  return `${JSON.stringify({ schemaVersion: 1, auditedAt, rows: orderedRows }, null, 2)}\n`
}
