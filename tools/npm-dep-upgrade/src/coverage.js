import semver from 'semver'
import { fail } from './errors.js'
export const consumerKey = e => JSON.stringify([e.location ?? e.from, e.requestedName, e.type])
const sameInstall = (a, b) => !!a && !!b && a.name === b.name && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity
function closure(edges, starts) {
  const next = new Map()
  for (const edge of edges) {
    if (edge.to === null) continue
    if (!next.has(edge.from)) next.set(edge.from, [])
    next.get(edge.from).push(edge.to)
  }
  const found = new Set(), pending = [...starts]
  for (let i = 0; i < pending.length; i++) if (!found.has(pending[i])) {
    found.add(pending[i])
    pending.push(...(next.get(pending[i]) || []))
  }
  return found
}
// A consumer branch is cleared when nothing reachable from where the consumer now lives is still an affected
// installation of the package: removing a dependency clears it, a descendant that reintroduces the vulnerability
// does not. Affected installations the consumer already reached by another route belong to other findings.
export function verifyCoverage(evidence, currentGraph) {
  const clearedConsumers = [], remainingConsumers = []
  const ranges = evidence.auditRows.filter(r => r.package === evidence.item.package).flatMap(r => r.advisories.map(a => a.range))
  const safe = node => semver.gt(node.version, evidence.item.version) && ranges.every(range => !semver.satisfies(node.version, range, { includePrerelease: true }))
  for (const original of evidence.incoming) {
    const current = currentGraph.edges.find(e => consumerKey(e) === consumerKey(original))
    if (current) {
      const node = currentGraph.nodes.get(current.to)
      if (!node || node.name !== evidence.item.package || !semver.validRange(current.rawSpec) || !semver.satisfies(node.version, current.rawSpec)) fail('INVALID_GRAPH', 'verification', 'Original consumer requirement is no longer satisfied')
    }
    const holder = evidence.graph.nodes.get(original.from), here = currentGraph.nodes.get(original.from)
    const holders = !holder || (here && here.name === holder.name)
      ? [original.from]
      : [...currentGraph.nodes].filter(([location, node]) => location && node.name === holder.name && evidence.graph.nodes.get(location)?.name !== holder.name).map(([location]) => location)
    const known = closure(evidence.graph.edges.filter(e => e !== original), [original.from])
    // Another original consumer's edge into the target is that consumer's own branch, not a route of this one.
    const others = new Set(evidence.incoming.filter(x => x.from !== original.from).map(consumerKey))
    const affected = [...closure(currentGraph.edges.filter(x => !others.has(consumerKey(x))), holders)].some((location) => {
      const node = currentGraph.nodes.get(location)
      return node?.name === evidence.item.package && !safe(node) && !(location !== evidence.item.targetLocation && known.has(location) && sameInstall(evidence.graph.nodes.get(location), node))
    })
    const consumer = { location: original.from, requestedName: original.requestedName, type: original.type }
    if (affected) remainingConsumers.push(consumer)
    else clearedConsumers.push(consumer)
  }
  let resolution = 'complete'
  if (!clearedConsumers.length) resolution = 'none'
  else if (remainingConsumers.length) resolution = 'partial'
  return { resolution, clearedConsumers, remainingConsumers }
}

export function verifyInstalledGraph(expected, actual) {
  for (const [location, node] of actual.nodes) {
    const locked = expected.nodes.get(location)
    if (!locked || node.name !== locked.name || node.version !== locked.version) fail('TARGET_MISMATCH', 'verification', `Installed dependency differs from verified graph: ${location}`)
  }
  const expectedEdges = new Map(expected.edges.map(edge => [consumerKey(edge), edge]))
  const actualEdges = new Map(actual.edges.map(edge => [consumerKey(edge), edge]))
  for (const edge of actual.edges) {
    if (edge.to === null && edge.optional) continue
    if (edge.valid === false || edge.to === null || !actual.nodes.has(edge.to)) fail('INVALID_GRAPH', 'verification', 'Installed tree contains an invalid required dependency')
    const locked = expectedEdges.get(consumerKey(edge))
    if (!locked || edge.to !== locked.to || edge.rawSpec !== locked.rawSpec || edge.effectiveSpec !== locked.effectiveSpec || Boolean(edge.optional) !== Boolean(locked.optional)) fail('INVALID_GRAPH', 'verification', 'Installed dependency relationship differs from verified graph')
  }
  for (const edge of expected.edges) {
    if (!actual.nodes.has(edge.from) || edge.optional) continue
    if (edge.to === null || !actual.nodes.has(edge.to) || !actualEdges.has(consumerKey(edge))) fail('INVALID_GRAPH', 'verification', 'Installed tree omits a required verified dependency')
  }
}
