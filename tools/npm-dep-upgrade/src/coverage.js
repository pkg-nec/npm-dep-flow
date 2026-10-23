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
  for (const edge of expected.edges) if (actual.nodes.has(edge.from) && edge.to !== null && !actual.nodes.has(edge.to) && !edge.optional) fail('INVALID_GRAPH', 'verification', 'Installed tree omits a required verified dependency')
}
