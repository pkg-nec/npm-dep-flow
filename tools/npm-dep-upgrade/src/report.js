const safe = s => Array.from(String(s), (c) => {
  const code = c.charCodeAt(0)
  return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : c
}).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\|[\]*_`])/g, '\\$1')
export const renderJson = result => JSON.stringify(result, null, 2) + '\n'
export function renderMarkdown(r) {
  return `# npm-dep-upgrade\n\n${safe(r.package)}: ${safe(r.oldVersion)} → ${safe(r.newVersion)}\n\nID: ${safe(r.id)}\n\nLocation: ${safe(r.targetLocation)}\n\nChanged files: ${r.changedFiles.map(safe).join(', ')}\n\nSupporting changes: ${r.supportingChanges.length}\n\nCommit: ${safe(r.commit.hash)}\n\n${safe(r.commit.subject)}\n`
}
