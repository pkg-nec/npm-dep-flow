import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { loadGraph } from './graph.js'
import { fail } from './errors.js'

export async function createScopeProbe(project, scratchRoot = tmpdir()) {
  const before = await loadGraph(project.root)
  return async (overrides) => {
    await mkdir(scratchRoot, { recursive: true })
    const dir = await mkdtemp(path.join(scratchRoot, 'npm-dep-upgrade-scope-'))
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...project.manifest, overrides }))
      await writeFile(path.join(dir, 'package-lock.json'), project.lockBytes)
      const after = await loadGraph(dir)
      const changed = after.edges.filter((e) => {
        const old = before.edges.find(b => b.from === e.from && b.requestedName === e.requestedName && b.type === e.type)
        return old && old.effectiveSpec !== e.effectiveSpec
      })
      return { affectedEdges: changed, changedParentSpecs: changed.filter(e => e.from === '') }
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  }
}

// Keep one scope per selector sequence and the physical locations at its head.
// Shared ancestry then stays a compact graph instead of becoming every route.
function addScope(scopes, route, head, graph) {
  const key = JSON.stringify(route.map((location) => {
    const node = graph.nodes.get(location)
    const rootEdge = graph.edges.find(e => e.from === '' && e.to === location)
    return [node.name, node.version, rootEdge?.requestedName]
  }))
  if (!scopes.has(key)) {
    if (scopes.size >= 1024) fail('UNSUPPORTED_SCOPE', 'scope', 'Too many distinct override scopes to isolate the selected installation')
    scopes.set(key, { route, heads: new Set() })
  }
  scopes.get(key).heads.add(head)
}

function upstreamParents(upstream) {
  const parents = new Map()
  for (const report of upstream) for (const edge of report.edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, new Set())
    parents.get(edge.to).add(edge.from)
  }
  return parents
}

function expandScopes(scopes, parents, graph) {
  const next = new Map()
  for (const { route, heads } of scopes.values()) for (const head of heads) {
    for (const parent of parents.get(head) || []) {
      if (parent === '') addScope(next, route, head, graph)
      else addScope(next, [parent, ...route], parent, graph)
    }
  }
  return next
}

function mergeRule(base, route, target, requirement, graph) {
  const node = graph.nodes.get(route[0])
  const key = `${node.name}@${node.version}`
  const existing = base[key]
  let value
  if (existing === undefined) value = {}
  else if (typeof existing === 'string') value = { '.': existing }
  else value = structuredClone(existing)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('OVERRIDE_CONFLICT', 'scope', 'Invalid existing override object')
  const rootEdge = graph.edges.find(e => e.from === '' && e.to === route[0])
  if (rootEdge && !Object.hasOwn(value, '.')) value['.'] = `$${rootEdge.requestedName}`
  if (route.length > 1) value = mergeRule(value, route.slice(1), target, requirement, graph)
  else {
    const old = value[target]
    const oldRange = typeof old === 'string' ? old : old?.['.']
    if (oldRange && (!semver.validRange(oldRange) || !semver.satisfies(semver.minVersion(requirement).version, oldRange))) fail('OVERRIDE_CONFLICT', 'scope', 'Existing override conflicts with selected version')
    value[target] = old && typeof old === 'object' ? { ...old, '.': requirement } : requirement
  }
  // More specific newly introduced rules precede broad existing rules, whose relative order stays intact.
  return { [key]: value, ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== key)) }
}

export async function planScopes(project, evidence, candidate, { probeScope }) {
  const { graph, item, incoming } = evidence
  if (incoming.some(e => e.requestedName !== item.package)) fail('UNSUPPORTED_SCOPE', 'scope', 'Alias override application is unsupported')
  for (const e of incoming) if (e.effectiveSpec !== e.rawSpec && (!semver.validRange(e.effectiveSpec) || !semver.satisfies(candidate.version, e.effectiveSpec))) fail('OVERRIDE_CONFLICT', 'scope', 'Existing override policy excludes the selected version')
  let scopes = new Map()
  for (const dependent of evidence.directDependents) if (dependent.location) addScope(scopes, [dependent.location], dependent.location, graph)
  const parents = upstreamParents(evidence.upstream)
  const requirement = candidate.version.includes('+') ? `>=${candidate.version} <=${candidate.version}` : candidate.version
  const attempted = new Set()
  // A useful acyclic context has at most one selector per package location.
  // This bound also terminates searches through cyclic dependency graphs.
  for (let depth = 1; scopes.size && depth <= graph.nodes.size; depth++) {
    let overrides = structuredClone(project.manifest.overrides || {})
    for (const { route } of scopes.values()) overrides = mergeRule(overrides, route, item.package, requirement, graph)
    const key = JSON.stringify(overrides)
    if (attempted.has(key)) break
    attempted.add(key)
    const impact = await probeScope(overrides)
    const targetEdges = impact.affectedEdges.filter(e => graph.nodes.get(e.to)?.name === item.package)
    if (!impact.changedParentSpecs.length && !targetEdges.some(e => e.to !== item.targetLocation) && incoming.every(original => targetEdges.some(e => e.from === original.from && e.requestedName === original.requestedName && e.type === original.type && semver.satisfies(candidate.version, e.effectiveSpec)))) return { overrides, scopedLocations: [item.targetLocation] }
    scopes = expandScopes(scopes, parents, graph)
  }
  fail('UNSUPPORTED_SCOPE', 'scope', 'Cannot express an override confined to the selected installation')
}
