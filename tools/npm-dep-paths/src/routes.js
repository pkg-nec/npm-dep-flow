import semver from 'semver'

const packageNamePattern = /^(?:[a-z0-9][a-z0-9._~-]*|@[^/@\s]+\/[^/@\s]+)$/i

export function parseSelector(input) {
  if (typeof input !== 'string' || !input) throw new Error('Invalid package selector')
  const separator = input.lastIndexOf('@')
  const hasVersion = separator > 0
  const name = hasVersion ? input.slice(0, separator) : input
  if (!packageNamePattern.test(name)) throw new Error(`Invalid package selector: ${input}`)
  if (!hasVersion) return { kind: 'name', name }
  const version = input.slice(separator + 1)
  if (semver.valid(version) !== version) throw new Error(`Expected an exact package version in selector: ${input}`)
  return { kind: 'exact', name, version }
}

function routeKey(route) {
  return route.slice(1).map(step => [step.incoming.name, step.version, step.location, step.incoming.type, step.incoming.spec].join('\u0000')).join('\u0001')
}

export function collectResults(graph, selector) {
  const root = graph.get('')
  if (!root) throw new Error('Dependency graph has no project root')
  const grouped = new Map()
  const stack = [{ location: '', route: [{ name: root.name, version: root.version, location: '', incoming: null }], visited: new Set(['']) }]
  while (stack.length) {
    const { location, route, visited } = stack.pop()
    const node = graph.get(location)
    if (location && node.name === selector.name && (selector.kind === 'name' || node.version === selector.version)) {
      if (!grouped.has(node.version)) grouped.set(node.version, [])
      grouped.get(node.version).push(route)
    }
    for (let i = node.edges.length - 1; i >= 0; i--) {
      const edge = node.edges[i]
      if (visited.has(edge.toLocation)) continue
      const target = graph.get(edge.toLocation)
      if (!target) throw new Error(`Dependency graph lacks ${edge.toLocation}`)
      stack.push({
        location: edge.toLocation,
        route: [...route, { name: target.name, version: target.version, location: target.location,
          incoming: { name: edge.name, type: edge.type, spec: edge.spec } }],
        visited: new Set([...visited, edge.toLocation]),
      })
    }
  }
  if (selector.kind === 'exact' && !grouped.has(selector.version)) {
    throw new Error(`Package version not found: ${selector.name}@${selector.version}`)
  }
  return [...grouped.entries()].sort(([a], [b]) => semver.compare(a, b)).map(([version, routes]) => {
    routes.sort((a, b) => routeKey(a).localeCompare(routeKey(b), 'en'))
    return { package: selector.name, version, routeCount: routes.length, routes }
  })
}
