import { choiceKey, compareText, consumerKey, consumersOf, releaseTimesOf } from './coverage.js'
import { PARENT_STRATEGY } from './ancestors.js'
import { TOOLCHAIN_STRATEGY, inToolchainScope, toolchainCandidateVersions, toolchainMembers } from './toolchain.js'

const isParent = choice => choice.strategy === PARENT_STRATEGY
const isToolchain = choice => choice.strategy === TOOLCHAIN_STRATEGY
const parse = bytes => (bytes ? JSON.parse(bytes.toString()) : null)
const sameKeys = (left, right) => left.size === right.size && [...left].every(key => right.has(key))

// Parent actions in the executor order (ancestor level, then location, name, version), then the others as given.
function executionOrder(choices) {
  const levelOf = choice => (choice.affectedConsumers.some(consumer => consumer.location === choice.targetLocation) ? 1 : 2)
  const byExecution = (a, b) => levelOf(a) - levelOf(b) || compareText(a.targetLocation, b.targetLocation) || compareText(a.targetPackage, b.targetPackage) || compareText(a.targetVersion, b.targetVersion)
  return [...choices.filter(isParent).sort(byExecution), ...choices.filter(choice => !isParent(choice))]
}

// Adds one Angular toolchain bump for the consumer branches the within-range and parent actions left uncovered, when
// those branches sit on a toolchain member or one level below one. The lowest same-major @angular/cli release that
// keeps every existing action and clears at least one such branch wins. Returns the oldest source freshness it used.
export async function planToolchainChoices({ finding, row, project, options, controls, adapters }) {
  if (finding.resolution === 'complete' || finding.choices.some(isToolchain)) return { freshAt: Infinity }
  const toolchain = toolchainMembers(parse(project.manifestBytes), parse(project.lockBytes)?.packages)
  if (!toolchain) return { freshAt: Infinity }

  const covered = new Set(finding.choices.flatMap(choice => choice.affectedConsumers.map(consumerKey)))
  const uncovered = [...consumersOf(row, finding.targetLocation)].filter(([key]) => !covered.has(key)).map(([, entry]) => entry)
  // The root declares a vulnerable member itself; any other root declaration is not moved by a toolchain bump.
  const rootInScope = inToolchainScope('', { edges: [{ from: '', to: finding.targetLocation }] }, toolchain.members)
  const nested = uncovered.filter(entry => entry.consumer.location !== '')
  if (!nested.length && !(rootInScope && uncovered.length)) return { freshAt: Infinity }
  const graph = nested.length
    ? await adapters.readUpstream(project.root, { package: finding.package, version: finding.version }, nested.map(entry => ({ name: entry.dependent.name, version: entry.dependent.version })), controls)
    : { nodes: new Map(), edges: [] }
  const inScope = uncovered.filter(entry => (entry.consumer.location === '' ? rootInScope : inToolchainScope(entry.consumer.location, graph, toolchain.members)))
  if (!inScope.length) return { freshAt: Infinity }

  const catalog = await adapters.readCatalog('@angular/cli')
  let freshAt = Date.parse(catalog.fetchedAt)
  const cli = toolchain.members.find(member => member.name === '@angular/cli')
  const choiceFor = (targetVersion, affectedConsumers) => ({ strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation: cli.location, currentVersion: toolchain.version, targetVersion, affectedConsumers })
  const item = { ...row, targetLocation: finding.targetLocation }
  const existing = executionOrder(finding.choices)
  // The worker lands an existing parent action only on a release whose publication time it knows.
  const releaseTimes = {}
  for (const name of new Set(existing.filter(isParent).map(choice => choice.targetPackage))) {
    const parentCatalog = await adapters.readCatalog(name)
    freshAt = Math.min(freshAt, Date.parse(parentCatalog.fetchedAt))
    releaseTimesOf(name, parentCatalog, releaseTimes)
  }
  const uncoveredKeys = new Set(uncovered.map(entry => consumerKey(entry.consumer)))
  const inScopeKeys = new Set(inScope.map(entry => consumerKey(entry.consumer)))
  // The toolchain bump must be resolved first: later actions are judged against the tree it leaves. A result counts
  // only when every action survives and an in-scope uncovered branch is cleared.
  const resolve = async (choice) => {
    const choices = [choice, ...existing]
    const verified = await adapters.resolveChoices(project, item, choices, { ...options, releaseTimes })
    freshAt = Math.min(freshAt, verified.freshAt)
    const accepted = new Set(verified.choices.map(choiceKey))
    const cleared = verified.coverage.clearedConsumers.filter(consumer => uncoveredKeys.has(consumerKey(consumer)))
    const suitable = choices.every(candidate => accepted.has(choiceKey(candidate))) && cleared.some(consumer => inScopeKeys.has(consumerKey(consumer)))
    return { verified, suitable, cleared: cleared.map(consumer => ({ location: consumer.location, requestedName: consumer.requestedName, type: consumer.type })) }
  }
  const keysOf = consumers => new Set(consumers.map(consumerKey))

  for (const version of toolchainCandidateVersions(toolchain.version, catalog.versions)) {
    const tentative = choiceFor(version, inScope.map(entry => entry.consumer))
    let result = await resolve(tentative)
    if (!result.suitable) continue
    const choice = choiceFor(version, result.cleared)
    if (!sameKeys(keysOf(choice.affectedConsumers), inScopeKeys)) {
      // The recorded consumers take part in the worker's verification, so the final choice is resolved again and must
      // clear exactly the consumers it records.
      result = await resolve(choice)
      if (!result.suitable || !sameKeys(keysOf(result.cleared), keysOf(choice.affectedConsumers))) continue
    }
    const parents = finding.choices.filter(isParent).sort((a, b) => compareText(a.targetLocation, b.targetLocation))
    finding.choices = [choice, ...parents, ...finding.choices.filter(candidate => !isParent(candidate))]
    finding.resolution = result.verified.coverage.resolution
    return { freshAt }
  }
  return { freshAt }
}
