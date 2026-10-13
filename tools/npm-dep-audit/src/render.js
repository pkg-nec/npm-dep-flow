function cell(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/[\r\n]/g, ' ')
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

export function renderMarkdown(rows) {
  const output = [
    '| Package | Version | Highest severity | Advisories | Installed paths |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    output.push(`| ${cell(row.package)} | ${cell(row.version)} | ${severity(row.severity)} | ${row.advisories.map(link).join('<br>')} | ${row.paths.map(cell).join('<br>')} |`)
  }
  if (rows.length === 0) output.push('', 'No matching direct advisories.')
  return `${output.join('\n')}\n`
}

export function renderJson(rows, auditedAt) {
  return `${JSON.stringify({ schemaVersion: 1, auditedAt, rows }, null, 2)}\n`
}
