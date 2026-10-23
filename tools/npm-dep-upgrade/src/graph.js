import Arborist from '@npmcli/arborist'
import { DEPENDENCY_FIELDS } from './model.js'
const types = { prod: 'dependencies', dev: 'devDependencies', peer: 'peerDependencies', peerOptional: 'peerDependencies', optional: 'optionalDependencies' }
export async function loadGraph(projectRoot, { actual = false } = {}) {
  const arb = new Arborist({ path: projectRoot, ignoreScripts: true })
  const tree = actual ? await arb.loadActual({ forceActual: true }) : await arb.loadVirtual()
  const nodes = new Map(), edges = []
  for (const node of tree.inventory.values()) {
    nodes.set(node.location, { location: node.location, name: node.package.name || node.name, version: node.version, resolved: node.resolved || null, integrity: node.integrity || null })
    for (const e of node.edgesOut.values()) {
      const fields = node === tree ? DEPENDENCY_FIELDS.filter(field => Object.hasOwn(node.package[field] || {}, e.name) && !(field === 'dependencies' && Object.hasOwn(node.package.optionalDependencies || {}, e.name))) : [types[e.type] || e.type]
      for (const type of fields) edges.push({ from: node.location, to: e.to?.location ?? null, requestedName: e.name, type, rawSpec: node === tree ? node.package[type][e.name] : e.rawSpec, effectiveSpec: e.spec, optional: e.optional, valid: e.valid })
    }
  }
  return { nodes, edges }
}
