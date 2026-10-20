import semver from 'semver'

const severityOrder = new Map([
  ['critical', 0],
  ['high', 1],
  ['moderate', 2],
  ['low', 3],
  ['info', 4],
])

const severityColors = new Map([
  ['moderate', 'yellow'],
  ['high', 'red'],
  ['critical', 'magenta'],
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

function compareRows(left, right) {
  return (severityOrder.get(left.severity) ?? Number.MAX_SAFE_INTEGER)
    - (severityOrder.get(right.severity) ?? Number.MAX_SAFE_INTEGER)
    || compareText(left.package, right.package)
    || compareVersion(left.version, right.version)
    || compareText(left.targetLocation, right.targetLocation)
}

export function sortFindings(rows) {
  return [...rows].sort(compareRows)
}

function safe(value) {
  return Array.from(String(value), (char) => {
    const code = char.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) return char
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\x${code.toString(16).padStart(2, '0')}`
  }).join('')
}

function escapeMarkdown(value) {
  return safe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\|[\]*_`])/g, '\\$1')
}

function displayValue(value) {
  return value === null || value === undefined || value === '' ? '—' : escapeMarkdown(value)
}

function displayReleasedAt(value) {
  if (value === null || value === undefined || value === '') return '—'

  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return displayValue(value)
  return timestamp.toISOString().replace('T', ' ').replace(/Z$/, ' UTC')
}

function displayLocation(location) {
  return location === '' ? '(project root)' : location
}

function renderSeverity(value) {
  const color = severityColors.get(value)
  const formatted = `<strong${color ? ` style="color: ${color}"` : ''}>${escapeMarkdown(value)}</strong>`
  return formatted
}

function renderStrategy(strategy) {
  if (!strategy) return '—'
  const label = escapeMarkdown(strategyLabels.get(strategy.id) ?? strategy.id)
  const current = `${escapeMarkdown(strategy.targetPackage)}@${escapeMarkdown(strategy.currentVersion)}`
  const target = `${escapeMarkdown(strategy.targetPackage)}@${escapeMarkdown(strategy.targetVersion)}`
  return `${label}: ${current} → ${target}`
}

export function renderMarkdown(rows) {
  const orderedRows = sortFindings(rows)
  if (orderedRows.length === 0) {
    return '# npm-dep-upgrade-plan\n\nNo vulnerable package findings.\n'
  }

  const output = [
    '# npm-dep-upgrade-plan',
    '',
    '| Package | Installed | Highest severity | Minimum safe version | Released at | Target location | Status | Strategy |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]

  for (const row of orderedRows) {
    output.push(`| ${escapeMarkdown(row.package)} | ${escapeMarkdown(row.version)} | ${renderSeverity(row.severity)} | ${displayValue(row.minimumSafeVersion)} | ${displayReleasedAt(row.minimumSafeVersionReleasedAt)} | ${escapeMarkdown(displayLocation(row.targetLocation))} | ${escapeMarkdown(row.status)} | ${renderStrategy(row.strategy)} |`)
  }

  return `${output.join('\n')}\n`
}

export function renderJson(rows, auditedAt) {
  const orderedRows = sortFindings(rows).map(row => ({
    package: row.package,
    version: row.version,
    targetLocation: row.targetLocation,
    severity: row.severity,
    minimumSafeVersion: row.minimumSafeVersion,
    minimumSafeVersionReleasedAt: row.minimumSafeVersionReleasedAt,
    status: row.status,
    strategy: row.strategy === null
      ? null
      : {
          id: row.strategy.id,
          targetPackage: row.strategy.targetPackage,
          currentVersion: row.strategy.currentVersion,
          targetVersion: row.strategy.targetVersion,
        },
  }))
  return `${JSON.stringify({ schemaVersion: 2, auditedAt, rows: orderedRows }, null, 2)}\n`
}
