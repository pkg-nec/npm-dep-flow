import semver from 'semver'
import { fail } from './errors.js'
import { DAY_MS } from './model.js'
import { readCandidateAdvisories, readCatalog, normalizeTimestamp } from './registry.js'
import { readFreshAudit } from './evidence.js'
export function closure(graph, start) {
  const found = new Set(), queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const location = queue[i]
    if (found.has(location)) continue
    found.add(location)
    for (const e of graph.edges) if (e.from === location && e.to !== null) queue.push(e.to)
  }
  return found
}
const equal = (a, b) => a && b && a.name === b.name && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity
export function verifyGraph(before, after, evidence, candidate, mutation, phase) {
  const { item, incoming } = evidence, location = item.targetLocation
  const target = after.nodes.get(location)
  if (!target || target.name !== item.package || target.version !== candidate.version) fail('TARGET_MISMATCH', phase, 'Selected target moved or did not resolve to the selected version')
  for (const e of incoming) {
    if (!semver.validRange(e.rawSpec) || !semver.satisfies(candidate.version, e.rawSpec)) fail('INVALID_GRAPH', phase, 'Selected version violates an original requirement')
    const current = after.edges.find(x => x.from === e.from && x.requestedName === e.requestedName && x.type === e.type)
    if (!current || current.to !== location) fail('TARGET_MISMATCH', phase, 'Original consumer no longer resolves the selected location')
    if (e.from && !equal(before.nodes.get(e.from), after.nodes.get(e.from))) fail('PARENT_CHANGED', phase, 'Parent installation changed')
  }
  for (const [loc, n] of before.nodes) if (n.name === item.package && loc !== location && !equal(n, after.nodes.get(loc))) fail('SCOPE_CHANGED', phase, 'Another target installation changed outside selected scope')
  for (const [loc, n] of after.nodes) if (n.name === item.package && loc !== location && !before.nodes.has(loc)) fail('SCOPE_CHANGED', phase, 'Additional target installation appeared outside selected scope')
  const oldClosure = closure(before, location), newClosure = closure(after, location), allowed = new Set([...oldClosure, ...newClosure])
  const changes = []
  for (const loc of new Set([...before.nodes.keys(), ...after.nodes.keys()])) {
    const old = before.nodes.get(loc), current = after.nodes.get(loc)
    if (equal(old, current)) continue
    if (!allowed.has(loc)) fail('UNRELATED_CHANGE', phase, `Unrelated installation changed outside target closure: ${loc}`)
    if (loc !== location) changes.push({ package: current?.name || old.name, oldLocation: old ? loc : null, newLocation: current ? loc : null, oldVersion: old?.version || null, newVersion: current?.version || null })
  }
  for (const e of after.edges) {
    const n = e.to === null ? null : after.nodes.get(e.to)
    if (!n) {
      if (e.optional) continue
      fail('INVALID_GRAPH', phase, 'Missing required dependency after install')
    }
    if (e.valid === false || (semver.validRange(e.effectiveSpec) && !semver.satisfies(n.version, e.effectiveSpec))) fail('INVALID_GRAPH', phase, `Invalid dependency requirement after install: ${e.requestedName}`)
  }
  const changedVersions = new Map([[item.package, [candidate.version]]])
  for (const loc of newClosure) {
    const n = after.nodes.get(loc)
    if (loc === location || !n) continue
    if (!oldClosure.has(loc) || !equal(before.nodes.get(loc), n)) changedVersions.set(n.name, [...new Set([...(changedVersions.get(n.name) || []), n.version])])
  }
  changes.sort((a, b) => (a.newLocation || a.oldLocation).localeCompare(b.newLocation || b.oldLocation))
  return { supportingChanges: changes, changedVersions }
}
// A changed version is acceptable when it adds no advisory the version it replaces did not already have; the
// version chosen for the vulnerable package itself must be clean, and a package with nothing to replace must be clean.
export async function verifyFinalSecurity(evidence, candidate, diff, context, adapters = {}) {
  const security = adapters.readCandidateAdvisories || readCandidateAdvisories
  const catalog = adapters.readCatalog || readCatalog
  const audit = adapters.readFreshAudit || readFreshAudit
  const replaced = diff.replacedVersions || new Map()
  const queried = new Map([...diff.changedVersions].map(([name, versions]) => [name, [...new Set([...versions, ...(replaced.get(name) || [])])]]))
  const advisories = await security(queried, context)
  const affecting = (name, version) => (advisories.get(name) || []).filter(a => semver.satisfies(version, a.range, { includePrerelease: true }))
  const root = context.projectRoot
  const now = Date.now(), cutoff = Math.min(now - (context.minAgeDays || 7) * DAY_MS, context.cutoffMs ?? Infinity)
  for (const [name, versions] of diff.changedVersions) {
    for (const version of versions) {
      const found = affecting(name, version)
      if (!found.length) continue
      if (name === evidence.item.package && version === candidate.version) fail('STALE_RECOMMENDATION', 'verification', 'Selected recommendation became stale; run planning again')
      const inherited = new Set((replaced.get(name) || []).flatMap(old => affecting(name, old).map(a => String(a.id))))
      if (found.some(a => !inherited.has(String(a.id)))) fail('VULNERABLE_SUPPORTING_CHANGE', 'verification', 'A supporting dependency change introduces a vulnerable version')
    }
    const metadata = await catalog(root, name, context)
    for (const version of versions) {
      const stamp = normalizeTimestamp(metadata.releaseTimes.get(version))
      if (!stamp || Date.parse(stamp) > cutoff) fail('RELEASE_AGE', 'verification', 'A resolved version has unverifiable or insufficient release age')
    }
  }
  const rows = await audit(root)
  for (const row of rows) {
    if (!(diff.changedVersions.get(row.package) || []).includes(row.version)) continue
    if (row.package === evidence.item.package && row.version === candidate.version) fail('STALE_RECOMMENDATION', 'verification', 'Fresh audit invalidates the recommendation; run planning again')
    const inherited = new Set((replaced.get(row.package) || []).flatMap(old => affecting(row.package, old).map(a => String(a.id))))
    if (row.advisories.some(a => !inherited.has(String(a.id)))) fail('VULNERABLE_SUPPORTING_CHANGE', 'verification', 'Fresh audit invalidates the recommendation; run planning again')
  }
}
