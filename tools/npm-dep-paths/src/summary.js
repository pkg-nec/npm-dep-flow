import semver from 'semver'

const compare = (a, b) => Number(a > b) - Number(a < b)

function reachableWithout(graph, excluded) {
  const reached = new Set()
  const pending = ['']
  while (pending.length) {
    const location = pending.pop()
    if (location === excluded || reached.has(location)) continue
    const node = graph.get(location)
    if (!node) throw new Error(`Dependency graph lacks ${location}`)
    reached.add(location)
    for (const edge of node.edges) pending.push(edge.toLocation)
  }
  return reached
}

function incomingEdges(graph) {
  const incoming = new Map()
  for (const parent of graph.values()) {
    for (const edge of parent.edges) {
      if (!incoming.has(edge.toLocation)) incoming.set(edge.toLocation, [])
      incoming.get(edge.toLocation).push({ parent, edge })
    }
  }
  return incoming
}

function compareDependent(a, b) {
  return compare(a.name, b.name) || compare(a.version, b.version)
    || compare(a.location, b.location) || compare(a.targetLocation, b.targetLocation)
    || compare(a.type, b.type) || compare(a.requestedName, b.requestedName)
}

export function collectSummaryResults(graph, selector) {
  if (!graph.has('')) throw new Error('Dependency graph has no project root')
  const matches = [...graph.values()].filter(node => node.location && node.name === selector.name
    && (selector.kind === 'name' || node.version === selector.version))
  if (!matches.length) {
    if (selector.kind === 'exact') throw new Error(`Package version not found: ${selector.name}@${selector.version}`)
    return []
  }
  const incoming = incomingEdges(graph)
  const byVersion = new Map()
  for (const target of matches) {
    const reachable = reachableWithout(graph, target.location)
    if (!byVersion.has(target.version)) byVersion.set(target.version, new Map())
    const bySpec = byVersion.get(target.version)
    for (const { parent, edge } of incoming.get(target.location) || []) {
      if (!reachable.has(parent.location)) continue
      if (!bySpec.has(edge.spec)) bySpec.set(edge.spec, new Map())
      const dependent = {
        name: parent.name,
        version: parent.version,
        location: parent.location,
        targetLocation: target.location,
        type: edge.type,
        requestedName: edge.name,
      }
      bySpec.get(edge.spec).set(JSON.stringify(dependent), dependent)
    }
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => semver.compare(a, b) || compare(a, b))
    .map(([version, bySpec]) => ({
      package: selector.name,
      version,
      requirements: [...bySpec.entries()].sort(([a], [b]) => compare(a, b)).map(([declaredRequirement, dependents]) => ({
        declaredRequirement,
        directDependents: [...dependents.values()].sort(compareDependent),
      })),
    }))
}
