import semver from 'semver'
import { runProcess } from './process.js'
import { loadGraph } from './graph.js'
import { fail } from './errors.js'
const edgeKey = (from,to,name,type,spec) => JSON.stringify([from,to,name,type,spec])
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
  const dependents = new Map()
  const graphEdges = new Set(graph.edges.map(e=>edgeKey(e.from,e.to,e.requestedName,e.type,e.rawSpec)))
  const parents = new Set(incoming.filter(e=>e.from).map(e=>{const n=graph.nodes.get(e.from);return `${n.name}@${n.version}`}))
  for (const parent of parents) {
    const r = await run('npm-dep-paths',['.',`${item.package}@${item.version}`,'--upstream-of',parent,'--format','json'],{cwd:project.root})
    if (r.code) fail('PATHS_FAILED','evidence',`Dependency paths failed: ${r.stderr.trim()}`)
    let data
    try { data=JSON.parse(r.stdout) } catch { fail('INVALID_PATHS','evidence','Invalid paths JSON') }
    if (data?.schemaVersion !== 2 || data.result?.package !== item.package || data.result?.version !== item.version || !Array.isArray(data.result.requirements) || !Array.isArray(data.upstream?.nodes) || !Array.isArray(data.upstream?.edges)) fail('INVALID_PATHS','evidence','Invalid upstream paths contract')
    for (const group of data.result.requirements) {
      if (typeof group?.declaredRequirement !== 'string' || !Array.isArray(group.directDependents)) fail('INVALID_PATHS','evidence','Invalid direct dependents contract')
      for (const dependent of group.directDependents) {
        if (!dependent || typeof dependent.targetLocation !== 'string') fail('INVALID_PATHS','evidence','Invalid direct dependent location')
        if (dependent.targetLocation !== item.targetLocation) continue
        const node = graph.nodes.get(dependent.location)
        if (!node || node.name !== dependent.name || node.version !== dependent.version || !graphEdges.has(edgeKey(dependent.location,item.targetLocation,dependent.requestedName,dependent.type,group.declaredRequirement))) fail('INVALID_PATHS','evidence','Paths direct dependent disagrees with the selected installation')
        const key = JSON.stringify([dependent.location,dependent.type,dependent.requestedName])
        dependents.set(key,{...dependent,declaredRequirement:group.declaredRequirement})
      }
    }
    for (const node of data.upstream.nodes) {
      const actual = graph.nodes.get(node?.location)
      if (!actual || actual.name !== node.name || actual.version !== node.version) fail('INVALID_PATHS','evidence','Upstream node disagrees with the dependency graph')
    }
    for (const edge of data.upstream.edges) if (!edge || !graphEdges.has(edgeKey(edge.from,edge.to,edge.requestedName,edge.type,edge.spec))) fail('INVALID_PATHS','evidence','Upstream edge disagrees with the dependency graph')
    upstream.push(data.upstream)
  }
  const directDependents = [...dependents.values()]
  if (incoming.some(e=>e.from && !directDependents.some(d=>d.location===e.from && d.type===e.type && d.requestedName===e.requestedName))) fail('INVALID_PATHS','evidence','Paths report omits an incoming requirement for the selected installation')
  return {item,auditRows,graph,incoming,directDeclarations,directDependents,upstream}
}
