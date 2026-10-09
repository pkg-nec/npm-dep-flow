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
  const title = cell(advisory.title)
  if (!advisory.url) return title
  const url = encodeURI(advisory.url).replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `[${title}](${url})`
}

export function renderMarkdown(rows) {
  const output = [
    '| Package | Version | Highest severity | Advisories | Installed paths |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    output.push(`| ${cell(row.package)} | ${cell(row.version)} | ${cell(row.severity)} | ${row.advisories.map(link).join('<br>')} | ${row.paths.map(cell).join('<br>')} |`)
  }
  if (rows.length === 0) output.push('', 'No matching direct advisories.')
  return `${output.join('\n')}\n`
}

export function renderJson(rows, auditedAt) {
  return `${JSON.stringify({ schemaVersion: 1, auditedAt, rows }, null, 2)}\n`
}
