function safe(value) {
  return Array.from(String(value), char => {
    const code = char.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) return char
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\x${code.toString(16).padStart(2, '0')}`
  }).join('')
}

function cell(value) {
  return safe(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\|[\]*_`])/g, '\\$1')
}

function link(advisory) {
  const code = cell(advisory.url.match(/\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/i)?.[0] ?? advisory.id)
  const title = cell(advisory.title)
  if (!advisory.url) return `(${code}) ${title}`
  const url = encodeURI(advisory.url).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `([${code}](${url})) ${title}`
}

function severity(value) {
  const colors = { moderate: 'yellow', high: 'red', critical: 'magenta' }
  const color = colors[value]
  return color ? `<strong style="color: ${color}">${cell(value)}</strong>` : `<strong>${cell(value)}</strong>`
}

function dependentLabel(dependent, targetName) {
  const alias = dependent.requestedName === targetName
    ? ''
    : `; requested as ${cell(dependent.requestedName)}`
  return `${cell(dependent.name)}@${cell(dependent.version)} [${cell(dependent.type)}${alias}]`
}

function visibleDependents(requirement, targetName) {
  const labels = new Map()
  for (const dependent of requirement.directDependents) {
    const label = dependentLabel(dependent, targetName)
    labels.set(label, (labels.get(label) || 0) + 1)
  }
  return [...labels].map(([label, count]) => count === 1 ? label : `${label} (${count} installations)`).join(', ')
}

function requirementsCell(row) {
  return row.requirements.map(requirement =>
    `${cell(requirement.declaredRequirement)} → ${visibleDependents(requirement, row.package)}`,
  ).join('<br>')
}

export function renderMarkdown(rows) {
  if (rows.length === 0) return '# npm-dep-audit\n\nNo matching direct advisories.\n'
  const output = [
    '# npm-dep-audit',
    '',
    '| Package | Version | Highest severity | Advisories | Declared requirements |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    output.push(`| ${cell(row.package)} | ${cell(row.version)} | ${severity(row.severity)} | ${row.advisories.map(link).join('<br>')} | ${requirementsCell(row)} |`)
  }
  return `${output.join('\n')}\n`
}

export function renderJson(rows, auditedAt) {
  const reportRows = rows.map(row => ({
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
      })),
    })),
  }))
  return `${JSON.stringify({ schemaVersion: 2, auditedAt, rows: reportRows }, null, 2)}\n`
}
