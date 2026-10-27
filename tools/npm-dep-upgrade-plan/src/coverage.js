import { safeStableVersions, declaredRange } from './strategies.js'
import semver from 'semver'

export const consumerKey = consumer => JSON.stringify([consumer.location, consumer.requestedName, consumer.type])
export const choiceKey = choice => JSON.stringify([choice.strategy, choice.targetPackage, choice.targetLocation, choice.targetVersion])
export const compareText = (a, b) => (Number(a > b) - Number(a < b))

// The audited consumers of one target installation, keyed by consumer identity, with the dependent that declares it.
export function consumersOf(row, targetLocation) {
  const consumers = new Map()
  for (const requirement of row.requirements) for (const dependent of requirement.directDependents) {
    if (dependent.targetLocation !== targetLocation) continue
    const consumer = { location: dependent.location, requestedName: dependent.requestedName, type: dependent.type }
    consumers.set(consumerKey(consumer), { consumer, dependent })
  }
  return consumers
}

// Adds a catalog's publication times to the resolver's `name@version` release-time map.
export function releaseTimesOf(name, catalog, into) {
  const entries = catalog.releaseTimes instanceof Map ? catalog.releaseTimes : Object.entries(catalog.releaseTimes || {})
  for (const [version, time] of entries) into[`${name}@${version}`] = time
}

export function selectWithinRangeChoices(row, targetLocation, catalog) {
  const consumers = new Map()
  for (const requirement of row.requirements) for (const dependent of requirement.directDependents) {
    if (dependent.targetLocation !== targetLocation) continue
    const consumer = { location: dependent.location, requestedName: dependent.requestedName, type: dependent.type }
    consumers.set(consumerKey(consumer), { consumer, range: declaredRange(row, requirement.declaredRequirement) })
  }
  const remaining = new Map([...consumers].sort(([a], [b]) => Number(a > b) - Number(a < b)))
  const choices = []
  const versions = safeStableVersions(row, Array.isArray(catalog) ? catalog : catalog.versions)
  while (remaining.size) {
    let best = null
    for (const version of versions) {
      const covered = [...remaining].filter(([, item]) => item.range && semver.satisfies(version, item.range))
      if (covered.length && (!best || covered.length > best.covered.length)) best = { version, covered }
    }
    if (!best) break
    choices.push({ strategy: 'update-within-declared-range', targetPackage: row.package, targetLocation, currentVersion: row.version, targetVersion: best.version, affectedConsumers: best.covered.map(([, item]) => item.consumer) })
    for (const [key] of best.covered) remaining.delete(key)
  }
  return choices
}

// After an ancestor upgrade a remaining consumer can declare a looser range than before (an exact pin becoming a caret,
// for example). Within-range actions for it are chosen from the declaration the resolved graph now carries.
export function selectResidualChoices(row, targetLocation, remaining, graph, catalog) {
  const nodes = new Map(graph.nodes.map(node => [node.location, node]))
  const requirements = []
  for (const consumer of remaining) {
    const edge = graph.edges.find(candidate => consumerKey({ location: candidate.from, requestedName: candidate.requestedName, type: candidate.type }) === consumerKey(consumer))
    if (!edge || nodes.get(edge.to)?.name !== row.package) continue
    requirements.push({ declaredRequirement: edge.rawSpec, directDependents: [{ location: consumer.location, requestedName: consumer.requestedName, type: consumer.type, targetLocation }] })
  }
  return selectWithinRangeChoices({ ...row, requirements }, targetLocation, catalog)
}

// paths reports npm's effective root edge; duplicate root fields also constrain it.
export function withRootDeclarations(rows, manifest) {
  return rows.map((row) => {
    const requirements = structuredClone(row.requirements)
    const roots = requirements.flatMap(r => r.directDependents.filter(d => d.location === ''))
    for (const root of roots) for (const type of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const spec = manifest[type]?.[root.requestedName]
      if (typeof spec !== 'string' || (type === 'dependencies' && Object.hasOwn(manifest.optionalDependencies || {}, root.requestedName))) continue
      if (requirements.some(r => r.directDependents.some(d => d.location === '' && d.requestedName === root.requestedName && d.type === type))) continue
      requirements.push({ declaredRequirement: spec, directDependents: [{ ...root, type }] })
    }
    return { ...row, requirements }
  })
}
