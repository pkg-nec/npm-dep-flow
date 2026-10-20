import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { loadGraph } from './graph.js'
import { fail } from './errors.js'
export async function createScopeProbe(project,scratchRoot=tmpdir()) {
  const before=await loadGraph(project.root)
  return async overrides=>{
    await mkdir(scratchRoot,{recursive:true})
    const dir=await mkdtemp(path.join(scratchRoot,'npm-dep-upgrade-scope-'))
    try {
      await writeFile(path.join(dir,'package.json'),JSON.stringify({...project.manifest,overrides}))
      await writeFile(path.join(dir,'package-lock.json'),project.lockBytes)
      const after=await loadGraph(dir)
      const changed=after.edges.filter(e=>{
        const old=before.edges.find(b=>b.from===e.from && b.requestedName===e.requestedName && b.type===e.type)
        return old && old.effectiveSpec!==e.effectiveSpec
      })
      return {affectedEdges:changed,changedParentSpecs:changed.filter(e=>e.from==='')}
    } finally {await rm(dir,{recursive:true,force:true})}
  }
}
function routesTo(graph,location,seen=new Set()) {
  if(location==='') return [[]]
  if(seen.has(location)) return []
  const next=new Set([...seen,location])
  const routes=[]
  for(const edge of graph.edges.filter(e=>e.to===location)) {
    for(const prefix of routesTo(graph,edge.from,next)) {
      routes.push([...prefix,location])
      if(routes.length>1024) fail('UNSUPPORTED_SCOPE','scope','Too many ancestry routes to prove a safe override scope')
    }
  }
  return routes
}
function mergeRule(base,route,target,requirement,graph) {
  const node=graph.nodes.get(route[0])
  const key=`${node.name}@${node.version}`
  const existing=base[key]
  let value=existing===undefined ? {} : typeof existing==='string' ? {'.':existing} : structuredClone(existing)
  if(!value || typeof value!=='object' || Array.isArray(value)) fail('OVERRIDE_CONFLICT','scope','Invalid existing override object')
  const rootEdge=graph.edges.find(e=>e.from==='' && e.to===route[0])
  if(rootEdge && !Object.hasOwn(value,'.')) value['.']=`$${rootEdge.requestedName}`
  if(route.length>1) value=mergeRule(value,route.slice(1),target,requirement,graph)
  else {
    const old=value[target]
    const oldRange=typeof old==='string' ? old : old?.['.']
    if(oldRange && (!semver.validRange(oldRange) || !semver.satisfies(requirement.slice(1),oldRange))) fail('OVERRIDE_CONFLICT','scope','Existing override conflicts with selected version')
    value[target]=old && typeof old==='object' ? {...old,'.':requirement} : requirement
  }
  // More specific newly introduced rules precede broad existing rules, whose relative order stays intact.
  return {[key]:value,...Object.fromEntries(Object.entries(base).filter(([k])=>k!==key))}
}
export async function planScopes(project,evidence,candidate,{probeScope}) {
  const {graph,item,incoming}=evidence
  if(incoming.some(e=>e.requestedName!==item.package)) fail('UNSUPPORTED_SCOPE','scope','Alias override application is unsupported')
  for(const e of incoming) if(e.effectiveSpec!==e.rawSpec && (!semver.validRange(e.effectiveSpec) || !semver.satisfies(candidate.version,e.effectiveSpec))) fail('OVERRIDE_CONFLICT','scope','Existing override policy excludes the selected version')
  const routes=[]
  for(const edge of incoming) {
    for(const route of routesTo(graph,edge.from)) routes.push({route,requirement:`${edge.rawSpec.trim().startsWith('~')?'~':'^'}${candidate.version}`})
  }
  const maxDepth=Math.max(0,...routes.map(r=>r.route.length))
  for(let depth=1;depth<=maxDepth;depth++) {
    let overrides=structuredClone(project.manifest.overrides || {})
    for(const r of routes) overrides=mergeRule(overrides,r.route.slice(-depth),item.package,r.requirement,graph)
    const impact=await probeScope(overrides)
    const targetEdges=impact.affectedEdges.filter(e=>graph.nodes.get(e.to)?.name===item.package)
    if(impact.changedParentSpecs.length || targetEdges.some(e=>e.to!==item.targetLocation)) continue
    if(incoming.every(original=>targetEdges.some(e=>e.from===original.from && e.requestedName===original.requestedName && e.type===original.type && semver.satisfies(candidate.version,e.effectiveSpec)))) return {overrides,scopedLocations:[item.targetLocation]}
  }
  fail('UNSUPPORTED_SCOPE','scope','Cannot express an override confined to the selected installation')
}
