import semver from 'semver'
import { consumerKey } from './coverage.js'
import { effectiveCutoff, MIN_RELEASE_AGE_FLOOR_DAYS } from './policy.js'

export const MAX_ANCESTOR_LEVELS = 2
export const PARENT_STRATEGY = 'upgrade-via-parent-dependency'

// An incoming declaration constrains the ancestor only when its range can be evaluated.
function rangeOf(spec) {
  const range = spec.startsWith('npm:') ? spec.slice(spec.lastIndexOf('@') + 1) : spec
  return semver.validRange(range)
}

function releasedAt(catalog, version) {
  const time = catalog.releaseTimes instanceof Map ? catalog.releaseTimes.get(version) : catalog.releaseTimes?.[version]
  return typeof time === 'string' ? Date.parse(time) : NaN
}

// The planner cannot pin a release it has no publication time for, and the executor refuses releases newer than the
// release-age cutoff from npm configuration, so neither is offered as a candidate.
function candidateVersions(ancestor, catalog, incoming, cutoff) {
  const ranges = incoming.map(edge => rangeOf(edge.spec))
  if (!incoming.length || ranges.includes(null)) return []
  return [...new Set(catalog.versions)]
    .filter(version => semver.valid(version) && !semver.prerelease(version) && semver.gt(version, ancestor.version) && ranges.every(range => semver.satisfies(version, range)) && releasedAt(catalog, version) <= cutoff)
    .sort(semver.compare)
}

function reverseIndex(graph) {
  const parents = new Map()
  for (const edge of graph.edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, new Set())
    parents.get(edge.to).add(edge.from)
  }
  return parents
}

// Bounded breadth-first ancestor search for the consumer branches that within-range actions did not cover.
// `evaluate(choices)` returns the keys of the original consumers a complete action set clears; it is the
// only authority on suitability, so a candidate counts only when the resolved closure clears its branch.
export async function findParentChoices({ unresolvedConsumers, graph, readCatalog, evaluate, accepted = [], now = Date.now(), policy = { minAgeDays: MIN_RELEASE_AGE_FLOOR_DAYS, cutoffMs: null } }) {
  const cutoff = effectiveCutoff(policy, now)
  const parentsOf = reverseIndex(graph)
  const catalogs = new Map()
  const catalogFor = (name) => {
    if (!catalogs.has(name)) catalogs.set(name, Promise.resolve(readCatalog(name)))
    return catalogs.get(name)
  }
  const branches = [...unresolvedConsumers].sort((a, b) => (Number(consumerKey(a) > consumerKey(b)) - Number(consumerKey(a) < consumerKey(b))))
  const unresolved = new Map(branches.map(consumer => [consumerKey(consumer), consumer]))
  const choices = []
  const cleared = new Set()

  for (const branch of branches) {
    if (cleared.has(consumerKey(branch))) continue
    const first = graph.nodes.get(branch.location)
    if (!first || first.location === '') continue
    const visited = new Set([first.location])
    let level = [first]
    for (let depth = 1; depth <= MAX_ANCESTOR_LEVELS && level.length && !cleared.has(consumerKey(branch)); depth++) {
      for (const ancestor of level) {
        const incoming = graph.edges.filter(edge => edge.to === ancestor.location)
        const catalog = await catalogFor(ancestor.name)
        for (const version of candidateVersions(ancestor, catalog, incoming, cutoff)) {
          const candidate = { strategy: PARENT_STRATEGY, targetPackage: ancestor.name, targetLocation: ancestor.location, currentVersion: ancestor.version, targetVersion: version, affectedConsumers: [] }
          const result = await evaluate([...accepted, ...choices, candidate])
          if (!result.has(consumerKey(branch)) || [...cleared].some(key => !result.has(key))) continue
          const newly = [...unresolved].filter(([key]) => result.has(key) && !cleared.has(key))
          candidate.affectedConsumers = newly.map(([, consumer]) => ({ location: consumer.location, requestedName: consumer.requestedName, type: consumer.type }))
          for (const [key] of newly) cleared.add(key)
          choices.push(candidate)
          break
        }
        if (cleared.has(consumerKey(branch))) break
      }
      if (cleared.has(consumerKey(branch))) break
      const next = []
      for (const ancestor of level) {
        for (const location of [...(parentsOf.get(ancestor.location) || [])].sort()) {
          if (location === '' || visited.has(location) || !graph.nodes.has(location)) continue
          visited.add(location)
          next.push(graph.nodes.get(location))
        }
      }
      level = next
    }
  }
  return choices.sort((a, b) => (Number(a.targetLocation > b.targetLocation) - Number(a.targetLocation < b.targetLocation)))
}
