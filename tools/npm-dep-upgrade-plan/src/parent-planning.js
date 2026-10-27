import { consumerKey, selectResidualChoices } from './coverage.js'
import { PARENT_STRATEGY } from './ancestors.js'

const isParent = choice => choice.strategy === PARENT_STRATEGY
const choiceKey = choice => JSON.stringify([choice.strategy, choice.targetPackage, choice.targetLocation, choice.targetVersion])
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function consumersOf(row, targetLocation) {
  const consumers = new Map()
  for (const requirement of row.requirements) for (const dependent of requirement.directDependents) {
    if (dependent.targetLocation !== targetLocation) continue
    const consumer = { location: dependent.location, requestedName: dependent.requestedName, type: dependent.type }
    consumers.set(consumerKey(consumer), { consumer, dependent })
  }
  return consumers
}

function releaseTimesOf(name, catalog, into) {
  const entries = catalog.releaseTimes instanceof Map ? catalog.releaseTimes : Object.entries(catalog.releaseTimes || {})
  for (const [version, time] of entries) into[`${name}@${version}`] = time
}

// Adds ancestor upgrades for the consumer branches within-range actions did not cover, then takes the final
// resolution from the jointly resolved action set. Returns the oldest source freshness it relied on.
export async function planParentChoices({ finding, row, project, options, controls, adapters }) {
  const consumers = consumersOf(row, finding.targetLocation)
  const covered = new Set(finding.choices.flatMap(choice => choice.affectedConsumers.map(consumerKey)))
  const unresolved = [...consumers].filter(([key]) => !covered.has(key)).map(([, entry]) => entry)
  const parents = unresolved.filter(entry => entry.consumer.location !== '').map(entry => ({ name: entry.dependent.name, version: entry.dependent.version }))
  if (!parents.length) return { freshAt: Infinity }

  let freshAt = Infinity
  const releaseTimes = {}
  const policy = await adapters.readReleasePolicy(project.root)
  const graph = await adapters.readUpstream(project.root, { package: finding.package, version: finding.version }, parents, controls)
  const readCatalog = async (name) => {
    const catalog = await adapters.readCatalog(name)
    freshAt = Math.min(freshAt, Date.parse(catalog.fetchedAt))
    releaseTimesOf(name, catalog, releaseTimes)
    return { versions: catalog.versions, releaseTimes: catalog.releaseTimes }
  }
  const item = { ...row, targetLocation: finding.targetLocation }
  // Parent actions execute first, as in the executor.
  // Sequential named updates are order dependent, so the order must match the executor: level, then location, name, version.
  const consumerLocations = new Set(unresolved.map(entry => entry.consumer.location))
  const levelOf = choice => (consumerLocations.has(choice.targetLocation) ? 1 : 2)
  const byExecution = (a, b) => levelOf(a) - levelOf(b) || compareText(a.targetLocation, b.targetLocation) || compareText(a.targetPackage, b.targetPackage) || compareText(a.targetVersion, b.targetVersion)
  const ordered = choices => [...choices.filter(isParent).sort(byExecution), ...choices.filter(choice => !isParent(choice))]
  const resolve = choices => adapters.resolveChoices(project, item, ordered(choices), { ...options, releaseTimes })
  const itemCatalog = await adapters.readCatalog(finding.package)
  freshAt = Math.min(freshAt, Date.parse(itemCatalog.fetchedAt))
  const kept = (verified, choices) => {
    const accepted = new Set(verified.choices.map(choiceKey))
    return choices.filter(isParent).every(choice => accepted.has(choiceKey(choice)))
  }
  // Resolves the action set. If remaining consumers now declare a range that accepts a safe version (an ancestor release
  // that turned an exact pin into a caret, say), a within-range action for them is added and the set resolved again.
  const resolveWithResidual = async (choices) => {
    const verified = await resolve(choices)
    freshAt = Math.min(freshAt, verified.freshAt)
    if (!kept(verified, choices)) return { verified, choices }
    const handled = new Set(choices.filter(choice => !isParent(choice)).flatMap(choice => choice.affectedConsumers.map(consumerKey)))
    const remaining = verified.coverage.remainingConsumers.filter(consumer => !handled.has(consumerKey(consumer)))
    if (!choices.some(isParent) || !remaining.length) return { verified, choices }
    const residual = selectResidualChoices(item, finding.targetLocation, remaining, verified.graph, itemCatalog)
    if (!residual.length) return { verified, choices }
    const withResidual = [...choices, ...residual]
    const again = await resolve(withResidual)
    freshAt = Math.min(freshAt, again.freshAt)
    return kept(again, choices) ? { verified: again, choices: withResidual } : { verified, choices }
  }
  const evaluate = async (choices) => {
    const { verified } = await resolveWithResidual(choices)
    if (!kept(verified, choices)) return new Set()
    return new Set(verified.coverage.clearedConsumers.map(consumerKey))
  }

  const parentChoices = await adapters.findParentChoices({ unresolvedConsumers: unresolved.map(entry => entry.consumer), graph, readCatalog, evaluate, accepted: finding.choices, policy })
  if (!parentChoices.length) return { freshAt }
  const { verified: final } = await resolveWithResidual([...finding.choices, ...parentChoices])
  finding.choices = [...final.choices.filter(choice => !isParent(choice)), ...final.choices.filter(isParent).sort((a, b) => compareText(a.targetLocation, b.targetLocation))]
  finding.resolution = final.coverage.resolution
  return { freshAt }
}
