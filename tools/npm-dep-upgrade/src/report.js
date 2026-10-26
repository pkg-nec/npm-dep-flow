const safe = s => Array.from(String(s), (c) => {
  const code = c.charCodeAt(0)
  return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : c
}).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\|[\]*_`])/g, '\\$1')
export const renderJson = result => JSON.stringify(result, null, 2) + '\n'
export function renderMarkdown(r) {
  const actions = r.actions.map(a => `${safe(a.targetPackage)}: ${safe(a.currentVersion)} → ${safe(a.targetVersion)} (${safe(a.outcome)})`).join('\n\n')
  const commits = r.commits.map(c => `${safe(c.hash)}: ${safe(c.subject)}`).join('\n\n')
  return `# npm-dep-upgrade\n\nID: ${safe(r.id)}\n\n${safe(r.package)}@${safe(r.oldVersion)}\n\nLocation: ${safe(r.targetLocation)}\n\nResolution: ${safe(r.resolution)}\n\n${actions}\n\n${commits}\n`
}
