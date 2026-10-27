import { runProcess } from './process.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => new Error(`Invalid npm-dep-paths upstream response: ${message}`)
const edgeKey = edge => JSON.stringify([edge.from, edge.to, edge.requestedName, edge.type, edge.spec])

function validate(data, target, parent) {
  if (!isRecord(data) || data.schemaVersion !== 2 || !isRecord(data.result) || !isRecord(data.upstream)) throw invalid('expected schema version 2 with result and upstream')
  if (data.result.package !== target.package || data.result.version !== target.version) throw invalid(`target is not ${target.package}@${target.version}`)
  if (!Array.isArray(data.result.requirements) || !Array.isArray(data.upstream.nodes) || !Array.isArray(data.upstream.edges)) throw invalid('missing requirements, nodes or edges')
  const selected = data.result.requirements.some(group => isRecord(group) && Array.isArray(group.directDependents)
    && group.directDependents.some(d => isRecord(d) && d.name === parent.name && d.version === parent.version))
  if (!selected) throw invalid(`${parent.name}@${parent.version} is not a direct dependent of ${target.package}@${target.version}`)
  const nodes = new Map()
  for (const node of data.upstream.nodes) {
    if (!isRecord(node) || typeof node.location !== 'string' || typeof node.name !== 'string' || !node.name || typeof node.version !== 'string' || !node.version) throw invalid('malformed node')
    if (nodes.has(node.location)) throw invalid(`duplicate node location ${node.location}`)
    nodes.set(node.location, { location: node.location, name: node.name, version: node.version })
  }
  const edges = []
  for (const edge of data.upstream.edges) {
    if (!isRecord(edge) || ['from', 'to', 'requestedName', 'type', 'spec'].some(field => typeof edge[field] !== 'string')) throw invalid('malformed edge or missing verbatim spec')
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw invalid('edge endpoint is not an upstream node')
    edges.push({ from: edge.from, to: edge.to, requestedName: edge.requestedName, type: edge.type, spec: edge.spec })
  }
  return { nodes, edges }
}

// Reads the public upward graph for one vulnerable target through each distinct immediate parent.
// One query returns every ancestor, so two ancestor levels need no further paths calls.
export async function readUpstream(projectRoot, target, parents, { noCache = false, clearCache = false, run = runProcess, spawnImpl, platform } = {}) {
  const merged = { nodes: new Map(), edges: [] }
  const seenEdges = new Set()
  const unique = [...new Map(parents.map(parent => [`${parent.name}@${parent.version}`, parent])).values()]
  for (const parent of unique) {
    const args = ['.', `${target.package}@${target.version}`, '--upstream-of', `${parent.name}@${parent.version}`, '--format', 'json', ...(noCache ? ['--no-cache'] : []), ...(clearCache ? ['--clear-cache'] : [])]
    let result
    try {
      result = await run('npm-dep-paths', args, projectRoot, spawnImpl, platform)
    }
    catch (error) {
      throw new Error(error?.code === 'ENOENT' ? 'npm-dep-paths is not available on PATH; install it as a standalone CLI' : 'Cannot start npm-dep-paths', { cause: error })
    }
    if (result.code !== 0) throw new Error(`npm-dep-paths failed for ${target.package}@${target.version} upstream of ${parent.name}@${parent.version} with exit code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
    let data
    try {
      data = JSON.parse(result.stdout)
    }
    catch (error) {
      throw new Error(`Invalid JSON from npm-dep-paths: ${error.message}`, { cause: error })
    }
    const graph = validate(data, target, parent)
    for (const [location, node] of graph.nodes) {
      const existing = merged.nodes.get(location)
      if (existing && (existing.name !== node.name || existing.version !== node.version)) throw invalid(`conflicting identities for ${location}`)
      merged.nodes.set(location, node)
    }
    for (const edge of graph.edges) {
      const key = edgeKey(edge)
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      merged.edges.push(edge)
    }
  }
  return merged
}
