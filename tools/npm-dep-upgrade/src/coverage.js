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
