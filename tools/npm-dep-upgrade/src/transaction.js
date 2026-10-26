import { writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveNpmPath } from './npm-context.js'
import { runProcess } from './process.js'
import { consumerKey, verifyCoverage } from './coverage.js'
import { fail } from './errors.js'
import { PARENT_STRATEGY } from './model.js'
import { orderChoices, parentRanges, selectParentRelease } from './parents.js'
const graph = data => ({ nodes: new Map(data.nodes.map(n => [n.location, n])), edges: data.edges })
const equal = (a, b) => a && b && a.name === b.name && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity
export async function executeActions(project, item, evidence, context, adapters) {
  const { staging } = adapters
  // Parent actions run first (ancestor level, then location/name/version), then within-range actions.
  const ordered = orderChoices(item, evidence)
  const catalogs = new Map()
  const readCatalog = (name) => {
    if (!catalogs.has(name)) catalogs.set(name, adapters.readCatalog(project.root, name, context))
    return catalogs.get(name)
  }
  const catalog = await readCatalog(item.package)
  const packageVersions = new Map([[item.package, catalog.versions]])
  for (const { choice } of ordered) if (choice.strategy === PARENT_STRATEGY) packageVersions.set(choice.targetPackage, (await readCatalog(choice.targetPackage)).versions)
  const advisories = await adapters.readCandidateAdvisories(packageVersions, context)
  const choices = [], candidates = [], releaseTimes = {}
  for (const { choice } of ordered) {
    if (choice.strategy === PARENT_STRATEGY) {
      const ancestorCatalog = await readCatalog(choice.targetPackage)
      const candidate = selectParentRelease(choice, parentRanges(choice, evidence.graph), { ...ancestorCatalog, minAgeDays: context.minAgeDays, cutoffMs: context.cutoffMs }, advisories.get(choice.targetPackage) || [], Date.now())
      releaseTimes[`${choice.targetPackage}@${candidate.version}`] = candidate.releasedAt
      candidates.push(candidate)
      choices.push({ ...choice, targetVersion: candidate.version })
      continue
    }
    const incoming = choice.affectedConsumers.map(consumer => evidence.incoming.find(e => consumerKey(e) === consumerKey(consumer)))
    const candidate = adapters.selectCandidate(item, incoming.map(e => e.rawSpec), { ...catalog, minAgeDays: context.minAgeDays, cutoffMs: context.cutoffMs }, advisories.get(item.package) || [], Date.now())
    candidates.push(candidate)
    choices.push({ ...choice, targetVersion: candidate.version })
  }
  const request = path.join(staging.root, 'resolve-request.json')
  const auditRow = evidence.auditRows.find(row => row.package === item.package && row.version === item.version)
  await writeFile(request, JSON.stringify({ root: staging.root, projectRoot: project.root, npmPath: await resolveNpmPath(), item: { ...item, advisories: auditRow?.advisories || [] }, choices, releaseTimes, startedAt: Date.now(), strict: true, enforceAge: true }), { mode: 0o600 })
  const response = await runProcess(process.execPath, [fileURLToPath(new URL('./resolver-worker.js', import.meta.url)), request], { cwd: staging.root })
  if (response.code) fail('RESOLUTION_FAILED', 'resolution', 'Cannot resolve selected upgrades: unsupported consumer scope, conflicting constraints, peer requirements, or npm registry/configuration failure')
  let resolved
  try {
    resolved = JSON.parse(response.stdout)
  }
  catch { fail('INVALID_GRAPH', 'resolution', 'Invalid resolver response') }
  const skipped = new Set(resolved.skipped || [])
  if (resolved.schemaVersion !== 1 || resolved.snapshots.length + skipped.size !== choices.length || new Set([...resolved.snapshots.map(snapshot => snapshot.choiceIndex), ...skipped]).size !== choices.length) fail('INVALID_GRAPH', 'resolution', 'Resolver omitted selected upgrades')
  const before = graph(resolved.before), snapshots = [], actions = new Array(choices.length)
  let previous = before
  for (const snapshot of resolved.snapshots) {
    const current = graph(snapshot.graph), choiceIndex = snapshot.choiceIndex, choice = choices[choiceIndex]
    const files = Object.fromEntries(Object.entries(snapshot.files).map(([name, content]) => [name, Buffer.from(content, 'base64')]))
    const parentAction = choice.strategy === PARENT_STRATEGY
    // The action's own installation is not a supporting change: the vulnerable package for within-range actions, the ancestor for parents.
    const own = (location, node) => (parentAction ? location === choice.targetLocation : node.name === item.package)
    const changedVersions = new Map([[choice.targetPackage, [choice.targetVersion]]]), supportingChanges = []
    for (const [location, node] of current.nodes) {
      if (!location || equal(previous.nodes.get(location), node)) continue
      if (node.name === item.package && node.version === item.version && [...before.nodes.values()].some(old => equal(old, node))) continue
      changedVersions.set(node.name, [...new Set([...(changedVersions.get(node.name) || []), node.version])])
      if (!own(location, node)) supportingChanges.push({ package: node.name, oldLocation: previous.nodes.has(location) ? location : null, newLocation: location, oldVersion: previous.nodes.get(location)?.version || null, newVersion: node.version })
    }
    for (const [location, node] of previous.nodes) {
      if (location && (parentAction || node.name !== item.package) && !current.nodes.has(location)) supportingChanges.push({ package: node.name, oldLocation: location, newLocation: null, oldVersion: node.version, newVersion: null })
    }
    const coverage = verifyCoverage(evidence, current)
    if (coverage.resolution === 'none') fail('NO_CHANGES', 'verification', 'Upgrade did not clear any vulnerable consumer')
    snapshots.push({ choiceIndex, files, graph: current, changedVersions, supportingChanges, candidate: candidates[choiceIndex] })
    const targetLocations = parentAction ? [choice.targetLocation] : [...new Set(choice.affectedConsumers.map(c => current.edges.find(e => consumerKey(e) === consumerKey(c))?.to))]
    actions[choiceIndex] = { ...choice, outcome: 'applied', targetLocations, releasedAt: candidates[choiceIndex].releasedAt, supportingChanges }
    previous = current
  }
  for (const choiceIndex of skipped) {
    const choice = choices[choiceIndex]
    const targetLocations = [...new Set(choice.affectedConsumers.map(c => previous.edges.find(e => consumerKey(e) === consumerKey(c))?.to).filter(Boolean))]
    actions[choiceIndex] = { ...choice, outcome: 'already-satisfied', targetLocations, releasedAt: candidates[choiceIndex].releasedAt, supportingChanges: [] }
  }
  const coverage = verifyCoverage(evidence, previous)
  if (coverage.resolution !== item.resolution) fail('STALE_RECOMMENDATION', 'verification', 'Resolved coverage differs from the current plan')
  // Keep a byte-level assertion: snapshots are produced by npm, not lockfile patches.
  const finalFiles = snapshots.at(-1).files
  for (const name of Object.keys(finalFiles)) if (!(await readFile(path.join(staging.root, name))).equals(finalFiles[name])) fail('CONCURRENT_CHANGE', 'verification', 'Staged dependency files changed')
  return { snapshots, actions, coverage }
}
