import { writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { resolveNpmPath } from './npm-context.js'
import { runProcess } from './process.js'
import { consumerKey, verifyCoverage } from './coverage.js'
import { fail } from './errors.js'
const graph = data => ({ nodes: new Map(data.nodes.map(n => [n.location, n])), edges: data.edges })
const equal = (a, b) => a && b && a.name === b.name && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity
export async function executeActions(project, item, evidence, context, adapters) {
  const { staging } = adapters
  const catalog = await adapters.readCatalog(project.root, item.package, context)
  const advisories = await adapters.readCandidateAdvisories(new Map([[item.package, catalog.versions]]), context)
  const choices = [], candidates = []
  for (const choice of item.choices) {
    const incoming = choice.affectedConsumers.map(consumer => evidence.incoming.find(e => consumerKey(e) === consumerKey(consumer)))
    if (incoming.some(e => !e)) fail('INVALID_PLAN', 'evidence', 'Choice consumer does not reference the selected installation')
    const candidate = adapters.selectCandidate(item, incoming.map(e => e.rawSpec), { ...catalog, minAgeDays: context.minAgeDays, cutoffMs: context.cutoffMs }, advisories.get(item.package) || [], Date.now())
    candidates.push(candidate)
    choices.push({ ...choice, targetVersion: candidate.version })
  }
  const request = path.join(staging.root, 'resolve-request.json')
  const auditRow = evidence.auditRows.find(row => row.package === item.package && row.version === item.version)
  await writeFile(request, JSON.stringify({ root: staging.root, projectRoot: project.root, npmPath: await resolveNpmPath(), item: { ...item, advisories: auditRow?.advisories || [] }, choices, startedAt: Date.now(), strict: true, enforceAge: true }), { mode: 0o600 })
  const response = await runProcess(process.execPath, [fileURLToPath(new URL('./resolver-worker.js', import.meta.url)), request], { cwd: staging.root })
  if (response.code) fail('RESOLUTION_FAILED', 'resolution', 'Cannot resolve selected upgrades: unsupported consumer scope, conflicting constraints, peer requirements, or npm registry/configuration failure')
  let resolved
  try {
    resolved = JSON.parse(response.stdout)
  }
  catch { fail('INVALID_GRAPH', 'resolution', 'Invalid resolver response') }
  if (resolved.schemaVersion !== 1 || resolved.snapshots.length !== choices.length) fail('INVALID_GRAPH', 'resolution', 'Resolver omitted selected upgrades')
  const before = graph(resolved.before), snapshots = [], actions = []
  let previous = before
  for (const snapshot of resolved.snapshots) {
    const current = graph(snapshot.graph), choiceIndex = snapshot.choiceIndex, choice = choices[choiceIndex]
    const files = Object.fromEntries(Object.entries(snapshot.files).map(([name, content]) => [name, Buffer.from(content, 'base64')]))
    const changedVersions = new Map([[item.package, [choice.targetVersion]]]), supportingChanges = []
    for (const [location, node] of current.nodes) {
      if (!location || equal(previous.nodes.get(location), node)) continue
      if (node.name === item.package && node.version === item.version && [...before.nodes.values()].some(old => equal(old, node))) continue
      changedVersions.set(node.name, [...new Set([...(changedVersions.get(node.name) || []), node.version])])
      if (node.name !== item.package) supportingChanges.push({ package: node.name, oldLocation: previous.nodes.has(location) ? location : null, newLocation: location, oldVersion: previous.nodes.get(location)?.version || null, newVersion: node.version })
    }
    const coverage = verifyCoverage(evidence, current)
    if (coverage.resolution === 'none') fail('NO_CHANGES', 'verification', 'Upgrade did not clear any vulnerable consumer')
    snapshots.push({ choiceIndex, files, graph: current, changedVersions, supportingChanges, candidate: candidates[choiceIndex] })
    const targetLocations = [...new Set(choice.affectedConsumers.map(c => current.edges.find(e => consumerKey(e) === consumerKey(c))?.to))]
    actions.push({ ...choice, outcome: 'applied', targetLocations, releasedAt: candidates[choiceIndex].releasedAt, supportingChanges })
    previous = current
  }
  const coverage = verifyCoverage(evidence, previous)
  if (coverage.resolution !== item.resolution) fail('STALE_RECOMMENDATION', 'verification', 'Resolved coverage differs from the current plan')
  // Keep a byte-level assertion: snapshots are produced by npm, not lockfile patches.
  const finalFiles = snapshots.at(-1).files
  for (const name of Object.keys(finalFiles)) if (!(await readFile(path.join(staging.root, name))).equals(finalFiles[name])) fail('CONCURRENT_CHANGE', 'verification', 'Staged dependency files changed')
  return { snapshots, actions, coverage }
}
