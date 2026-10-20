import semver from 'semver'
import { runProcess } from './process.js'
import { loadGraph } from './graph.js'
import { fail } from './errors.js'
export async function readFreshAudit(root, run = runProcess) {
  const r = await run('npm-dep-audit', ['.', '--min-severity','info','--no-cache','--format','json'], { cwd:root })
  if (r.code) fail('AUDIT_FAILED','audit',`Fresh audit failed: ${r.stderr.trim()}`)
  let report
  try { report=JSON.parse(r.stdout) } catch { fail('INVALID_AUDIT','audit','Invalid audit JSON') }
  if (report?.schemaVersion !== 2 || !Array.isArray(report.rows) || !Number.isFinite(Date.parse(report.auditedAt))) fail('INVALID_AUDIT','audit','Invalid audit schema')
  for (const row of report.rows) if (!row || typeof row.package !== 'string' || !semver.valid(row.version) || !Array.isArray(row.advisories) || row.advisories.some(a=>!a || !semver.validRange(a.range))) fail('INVALID_AUDIT','audit','Invalid audit row')
  return report.rows
}
export async function readEvidence(project,item,run = runProcess) {
  const graph = await loadGraph(project.root)
  const node = graph.nodes.get(item.targetLocation)
  if (!node || node.name !== item.package || node.version !== item.version) fail('STALE_RECOMMENDATION','evidence','Target installation changed; recommendation is stale')
  const auditRows = await readFreshAudit(project.root,run)
  if (!auditRows.some(r=>r.package===item.package && r.version===item.version)) fail('STALE_RECOMMENDATION','evidence','Target is absent from fresh audit; recommendation is stale')
  const incoming = graph.edges.filter(e=>e.to===item.targetLocation)
  if (!incoming.length) fail('INVALID_EVIDENCE','evidence','Target has no incoming requirements')
  const directDeclarations = incoming.filter(e=>e.from==='').map(e=>({field:e.type,requestedName:e.requestedName,spec:e.rawSpec}))
  const upstream = []
  const parents = new Set(incoming.filter(e=>e.from).map(e=>{const n=graph.nodes.get(e.from);return `${n.name}@${n.version}`}))
  for (const parent of parents) {
    const r = await run('npm-dep-paths',['.',`${item.package}@${item.version}`,'--upstream-of',parent,'--format','json'],{cwd:project.root})
    if (r.code) fail('PATHS_FAILED','evidence',`Dependency paths failed: ${r.stderr.trim()}`)
    let data
    try { data=JSON.parse(r.stdout) } catch { fail('INVALID_PATHS','evidence','Invalid paths JSON') }
    if (data?.schemaVersion !== 2 || !Array.isArray(data.upstream?.nodes) || !Array.isArray(data.upstream?.edges)) fail('INVALID_PATHS','evidence','Invalid upstream paths contract')
    upstream.push(data.upstream)
  }
  return {item,auditRows,graph,incoming,directDeclarations,upstream}
}
