import semver from 'semver'

const fields = ['peerDependencies', 'dependencies', 'optionalDependencies', 'devDependencies']

function parentLocation(location) {
  const marker = 'node_modules/'
  const index = location.lastIndexOf(marker)
  return index < 0 ? '' : location.slice(0, index).replace(/\/$/, '')
}

function installedName(location, entry) {
  if (typeof entry.name === 'string' && entry.name) return entry.name
  return location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

function declarations(pkg, root) {
  const byName = new Map()
  for (const type of fields) {
    if (type === 'devDependencies' && !root) continue
    for (const [name, spec] of Object.entries(pkg[type] || {})) {
      byName.set(name, { name, type, spec })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.type.localeCompare(b.type, 'en'))
}

function lookup(packages, from, name, peer) {
  let base = peer ? parentLocation(from) : from
  while (true) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`
    if (Object.hasOwn(packages, candidate)) return candidate
    if (!base) return null
    base = parentLocation(base)
  }
}

export function buildGraph(project) {
  const packages = project.lock.packages
  const graph = new Map()
  const queue = ['']
  graph.set('', { name: project.manifest.name, version: project.manifest.version, location: '', edges: [] })
  for (let i = 0; i < queue.length; i++) {
    const location = queue[i]
    const node = graph.get(location)
    const entry = location ? packages[location] : project.manifest
    for (const { name, type, spec } of declarations(entry, location === '')) {
      const optional = type === 'optionalDependencies'
        || (type === 'peerDependencies' && entry.peerDependenciesMeta?.[name]?.optional === true)
      const toLocation = lookup(packages, location, name, type === 'peerDependencies')
      if (toLocation === null) {
        if (optional) continue
        throw new Error(`Unresolved ${type} ${name} declared by ${node.name}@${node.version} (${location || 'root'})`)
      }
      const target = packages[toLocation]
      if (!target || typeof target.version !== 'string' || semver.valid(target.version) === null) {
        throw new Error(`Invalid or missing version for ${name} at ${toLocation}, declared by ${node.name}@${node.version}`)
      }
      node.edges.push({ name, type, spec, toLocation })
      if (!graph.has(toLocation)) {
        graph.set(toLocation, { name: installedName(toLocation, target), version: target.version, location: toLocation, edges: [] })
        queue.push(toLocation)
      }
    }
  }
  return graph
}
