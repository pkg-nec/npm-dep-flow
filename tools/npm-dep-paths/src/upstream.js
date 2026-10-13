const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const edgeKey = edge => JSON.stringify([edge.from, edge.to, edge.requestedName, edge.type, edge.spec])

function reverseEdges(graph) {
  const parents = new Map()
  for (const node of graph.values()) {
    for (const edge of node.edges) {
      if (!parents.has(edge.toLocation)) parents.set(edge.toLocation, [])
      parents.get(edge.toLocation).push(node.location)
    }
  }
  return parents
}

function ancestorsOf(parents, selectedLocations) {
  const ancestors = new Set()
  const pending = [...selectedLocations]
  while (pending.length) {
    const location = pending.pop()
    if (ancestors.has(location)) continue
    ancestors.add(location)
    pending.push(...(parents.get(location) || []))
  }
  return ancestors
}

function outputEdge(from, edge) {
  return { from, to: edge.toLocation, requestedName: edge.name, type: edge.type, spec: edge.spec }
}

export function collectUpstream(graph, result, dependent, from) {
  if (dependent.kind !== 'exact') throw new Error('Expected an exact direct dependent version')
  const selectedLinks = result.requirements.flatMap(group => group.directDependents
    .filter(item => item.name === dependent.name && item.version === dependent.version)
    .map(item => ({ ...item, spec: group.declaredRequirement })))
  if (!selectedLinks.length) {
    throw new Error(`No direct dependent ${dependent.name}@${dependent.version} leads to ${result.package}@${result.version}`)
  }
  const selectedLocations = new Set(selectedLinks.map(item => item.location))
  const ancestors = ancestorsOf(reverseEdges(graph), selectedLocations)
  const root = graph.get('')
  if (!root) throw new Error('Dependency graph has no project root')
  const topLevelEdges = root.edges.filter(edge => {
    if (!ancestors.has(edge.toLocation)) return false
    if (!from) return true
    const node = graph.get(edge.toLocation)
    return node?.name === from.name && node.version === from.version
  })
  if (from && from.kind !== 'exact') throw new Error('Expected an exact top-level package version')
  if (from && !topLevelEdges.length) throw new Error(`Top-level package ${from.name}@${from.version} does not lead to ${dependent.name}@${dependent.version}`)
  const allowedRootEdges = new Set(topLevelEdges)
  const reached = new Set()
  const pending = ['']
  const edges = new Map()
  while (pending.length) {
    const location = pending.pop()
    if (reached.has(location) || !ancestors.has(location)) continue
    const node = graph.get(location)
    if (!node) throw new Error(`Dependency graph lacks ${location}`)
    reached.add(location)
    for (const edge of node.edges) {
      if (!ancestors.has(edge.toLocation) || (location === '' && !allowedRootEdges.has(edge))) continue
      const output = outputEdge(location, edge)
      edges.set(edgeKey(output), output)
      pending.push(edge.toLocation)
    }
  }
  const selected = [...selectedLocations].filter(location => reached.has(location)).sort(compare)
  if (from && !selected.length) throw new Error(`Top-level package ${from.name}@${from.version} does not lead to ${dependent.name}@${dependent.version}`)
  const targetLocations = new Set()
  for (const link of selectedLinks) {
    if (!reached.has(link.location)) continue
    const output = {
      from: link.location, to: link.targetLocation, requestedName: link.requestedName,
      type: link.type, spec: link.spec,
    }
    edges.set(edgeKey(output), output)
    targetLocations.add(link.targetLocation)
  }
  for (const location of targetLocations) reached.add(location)
  const nodes = [...reached].sort(compare).map(location => {
    const node = graph.get(location)
    if (!node) throw new Error(`Dependency graph lacks ${location}`)
    return { location, name: node.name, version: node.version }
  })
  return {
    selectedDependent: `${dependent.name}@${dependent.version}`,
    rootLocation: '',
    selectedLocations: selected,
    targetLocations: [...targetLocations].sort(compare),
    topLevelLocations: [...new Set(topLevelEdges.map(edge => edge.toLocation))].filter(location => reached.has(location)).sort(compare),
    nodes,
    edges: [...edges.values()].sort((a, b) => compare(edgeKey(a), edgeKey(b))),
  }
}
