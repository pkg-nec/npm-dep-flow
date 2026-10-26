import semver from 'semver'
import { fail } from './errors.js'
export const consumerKey = e => JSON.stringify([e.location ?? e.from, e.requestedName, e.type])
export function verifyCoverage(evidence, currentGraph) {
  const clearedConsumers = [], remainingConsumers = []
  const ranges = evidence.auditRows.filter(r => r.package === evidence.item.package).flatMap(r => r.advisories.map(a => a.range))
  for (const original of evidence.incoming) {
    const current = currentGraph.edges.find(e => consumerKey(e) === consumerKey(original))
    const node = currentGraph.nodes.get(current?.to)
    if (!node || node.name !== evidence.item.package || !semver.validRange(original.rawSpec) || !semver.satisfies(node.version, original.rawSpec)) fail('INVALID_GRAPH', 'verification', 'Original consumer requirement is no longer satisfied')
    const consumer = { location: original.from, requestedName: original.requestedName, type: original.type }
    const safe = semver.gt(node.version, evidence.item.version) && ranges.every(range => !semver.satisfies(node.version, range, { includePrerelease: true }))
    if (safe) clearedConsumers.push(consumer)
    else remainingConsumers.push(consumer)
  }
  return { resolution: !clearedConsumers.length ? 'none' : remainingConsumers.length ? 'partial' : 'complete', clearedConsumers, remainingConsumers }
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
