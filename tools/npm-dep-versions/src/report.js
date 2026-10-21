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

export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function renderMarkdown(report) {
  const lines = ['# npm-dep-versions', '', `Package: ${escapeMarkdown(report.package)}`, '', `Fetched at: ${displayReleasedAt(report.fetchedAt)}`, '']
  if (!report.rows.length) return [...lines, 'No matching versions.', ''].join('\n')
  lines.push('| Version | Released at |', '| --- | --- |')
  for (const row of report.rows) lines.push(`| ${escapeMarkdown(row.version)} | ${displayReleasedAt(row.releasedAt)} |`)
  return lines.join('\n') + '\n'
}
