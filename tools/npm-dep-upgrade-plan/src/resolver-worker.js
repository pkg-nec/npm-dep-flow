// Standalone worker: only npm's in-memory resolver, private lock serialization, and the toolchain constants.
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { TOOLCHAIN_MEMBERS, TOOLCHAIN_STRATEGY } from './toolchain.js'

const key = e => JSON.stringify([e.location ?? e.from, e.requestedName, e.type])
const types = { prod: 'dependencies', dev: 'devDependencies', peer: 'peerDependencies', peerOptional: 'peerDependencies', optional: 'optionalDependencies' }

function graph(tree) {
  const nodes = [], edges = []
  for (const n of tree.inventory.values()) {
    nodes.push({ location: n.location, name: n.package.name || n.name, version: n.version, resolved: n.resolved || null, integrity: n.integrity || null })
    for (const e of n.edgesOut.values()) {
      const fields = n === tree ? ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].filter(field => Object.hasOwn(n.package[field] || {}, e.name) && !(field === 'dependencies' && Object.hasOwn(n.package.optionalDependencies || {}, e.name))) : [types[e.type] || e.type]
      for (const type of fields) edges.push({ from: n.location, to: e.to?.location ?? null, requestedName: e.name, type, rawSpec: n === tree ? n.package[type][e.name] : e.rawSpec, effectiveSpec: e.spec, optional: e.optional, valid: e.valid })
    }
  }
  return { nodes, edges }
}

const equal = (a, b) => !!a && !!b && a.name === b.name && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity

function closure(g, starts) {
  const found = new Set(), pending = [...starts]
  const next = new Map()
  for (const e of g.edges) {
    if (!next.has(e.from)) next.set(e.from, [])
    if (e.to !== null) next.get(e.from).push(e.to)
  }
  for (let i = 0;
    i < pending.length;
    i++) if (!found.has(pending[i])) {
    found.add(pending[i])
    pending.push(...(next.get(pending[i]) || []))
  }
  return found
}

const PARENT_STRATEGY = 'upgrade-via-parent-dependency'
const isParent = choice => choice.strategy === PARENT_STRATEGY
const isToolchain = choice => choice.strategy === TOOLCHAIN_STRATEGY
const isAncestor = choice => isParent(choice) || isToolchain(choice)
// The root declarations of the toolchain members, as edges of the given graph.
const memberEdges = g => g.edges.filter(e => e.from === '' && TOOLCHAIN_MEMBERS.includes(e.requestedName))

// Toolchain and parent choices are both ancestor changes: their closures before and after are in scope.
export function verifyResolution(before, after, item, choices, semver) {
  const withinRange = choices.filter(c => !isAncestor(c)), parents = choices.filter(isParent), ancestors = choices.filter(isAncestor)
  const oldNodes = new Map(before.nodes.map(n => [n.location, n])), nodes = new Map(after.nodes.map(n => [n.location, n]))
  const selected = new Map(withinRange.flatMap(c => c.affectedConsumers.map(e => [key(e), c])))
  const parentSelected = new Set(ancestors.flatMap(c => c.affectedConsumers.map(key)))
  for (const choice of parents) {
    const old = oldNodes.get(choice.targetLocation), landed = nodes.get(choice.targetLocation)
    if (!old || old.name !== choice.targetPackage || old.version !== choice.currentVersion) throw new Error('Ancestor installation changed since planning')
    if (!landed || landed.name !== choice.targetPackage || landed.version !== choice.targetVersion) throw new Error('Ancestor did not resolve to the tested version')
    for (const n of before.nodes) if (n.name === choice.targetPackage && n.location !== choice.targetLocation && !equal(n, nodes.get(n.location))) throw new Error('Another ancestor installation changed')
  }
  const toolchainBefore = [], toolchainAfter = []
  if (choices.some(isToolchain)) {
    for (const old of memberEdges(before)) {
      const choice = choices.find(isToolchain), current = after.edges.find(e => key(e) === key(old))
      const oldNode = oldNodes.get(old.to), landed = nodes.get(current?.to)
      if (oldNode?.name !== old.requestedName || oldNode.version !== choice.currentVersion) throw new Error('Toolchain installation changed since planning')
      if (landed?.name !== old.requestedName || landed.version !== choice.targetVersion) throw new Error('Toolchain member did not resolve to the tested version')
      toolchainBefore.push(old.to)
      toolchainAfter.push(current.to)
    }
    if (!toolchainBefore.length) throw new Error('Toolchain installation changed since planning')
  }
  const parentLocations = parents.map(c => c.targetLocation)
  const parentClosureBefore = closure(before, [...parentLocations, ...toolchainBefore]), parentClosureAfter = closure(after, [...parentLocations, ...toolchainAfter])
  const scoped = new Set([...closure(before, [item.targetLocation]), ...parentClosureBefore, ...parentClosureAfter])
  const oldIncoming = before.edges.filter(e => e.to === item.targetLocation)
  for (const n of before.nodes) if (n.location && n.name !== item.package && !equal(n, nodes.get(n.location)) && !scoped.has(n.location)) throw new Error('Unrelated parent installation changed')
  for (const old of before.edges) {
    const oldNode = oldNodes.get(old.to)
    if (oldNode?.name !== item.package) continue
    const current = after.edges.find(e => key(e) === key(old))
    const currentNode = nodes.get(current?.to)
    if (oldIncoming.includes(old)) {
      const choice = selected.get(key(old))
      if (!choice && (parentSelected.has(key(old)) || parentClosureBefore.has(old.from))) {
        // The ancestor's own change may remove this dependency; if it survives it must satisfy its current declaration.
        if (current && (!currentNode || currentNode.name !== item.package || !semver.validRange(current.rawSpec) || !semver.satisfies(currentNode.version, current.rawSpec))) throw new Error('Original consumer requirement not satisfied')
        continue
      }
      // After an ancestor upgrade a consumer may declare a different range than before; judge it by what it declares now.
      const declared = ancestors.length && current ? current.rawSpec : old.rawSpec
      if (!currentNode || currentNode.name !== item.package || !semver.validRange(declared) || !semver.satisfies(currentNode.version, declared)) throw new Error('Original consumer requirement not satisfied')
      // An ancestor's new closure may let npm dedupe the shared installation upward; moving a consumer to a newer
      // valid release of the same installation is permitted then, but never to an older one or to another location.
      const upgradedInPlace = ancestors.length > 0 && !choice && current.to === old.to && semver.gt(currentNode.version, oldNode.version)
      if (choice ? currentNode.version !== choice.targetVersion : !equal(oldNode, currentNode) && !upgradedInPlace) throw new Error('Consumer resolved outside intended scope')
    }
    else if (oldNode?.name === item.package && !equal(oldNode, currentNode) && !parentClosureBefore.has(old.from)) throw new Error('Another target installation changed')
  }
  const newTargets = oldIncoming.map(e => after.edges.find(x => key(x) === key(e))?.to).filter(x => x !== undefined)
  const allowed = new Set([...closure(before, [item.targetLocation]), ...closure(after, newTargets), ...parentClosureBefore, ...parentClosureAfter])
  for (const n of [...before.nodes, ...after.nodes]) if (n.location && !equal(oldNodes.get(n.location), nodes.get(n.location)) && !allowed.has(n.location)) throw new Error('Unrelated installation changed')
  for (const e of after.edges) if (e.to === null ? !e.optional : e.valid === false) throw new Error('Invalid dependency graph after resolution')
}
// A consumer branch is cleared when nothing reachable from where the consumer now lives is still an affected
// installation of the package, so removing a dependency clears it but a descendant that reintroduces the
// vulnerability does not. Affected installations the consumer already reached by another route are other findings.
export function computeCoverage(before, after, item, semver) {
  const oldNodes = new Map(before.nodes.map(n => [n.location, n])), nodes = new Map(after.nodes.map(n => [n.location, n]))
  const safe = n => semver.gt(n.version, item.version) && item.advisories.every(a => !semver.satisfies(n.version, a.range))
  const clearedConsumers = [], remainingConsumers = []
  for (const e of before.edges.filter(e => e.to === item.targetLocation)) {
    const holder = oldNodes.get(e.from), here = nodes.get(e.from)
    // The root's declaration of a toolchain member is judged from the member's new installation: everything else
    // the root reaches belongs to other branches, such as another member's closure.
    const rootMember = e.from === '' && TOOLCHAIN_MEMBERS.includes(item.package)
    const landed = rootMember ? after.edges.find(x => key(x) === key(e))?.to : null
    let holders
    if (rootMember) holders = landed ? [landed] : []
    else if (here && holder && here.name === holder.name) holders = [e.from]
    else holders = after.nodes.filter(n => n.location && holder && n.name === holder.name && oldNodes.get(n.location)?.name !== holder.name).map(n => n.location)
    const known = closure({ edges: before.edges.filter(x => x !== e) }, [e.from])
    // Another original consumer's edge into the target is that consumer's own branch, not a route of this one.
    const others = new Set(before.edges.filter(x => x.to === item.targetLocation && x.from !== e.from).map(key))
    const reachable = closure({ edges: after.edges.filter(x => !others.has(key(x))) }, holders)
    const affected = [...reachable].some((location) => {
      const n = nodes.get(location)
      return n?.name === item.package && !safe(n) && !(location !== item.targetLocation && known.has(location) && equal(oldNodes.get(location), n))
    })
    ;
    (affected ? remainingConsumers : clearedConsumers).push({ location: e.from, requestedName: e.requestedName, type: e.type })
  }
  let resolution = 'complete'
  if (!clearedConsumers.length) resolution = 'none'
  else if (remainingConsumers.length) resolution = 'partial'
  return { resolution, clearedConsumers, remainingConsumers }
}
export function choiceSatisfied(current, choice, item, semver) {
  const nodes = new Map(current.nodes.map(n => [n.location, n]))
  return choice.affectedConsumers.every((consumer) => {
    const edge = current.edges.find(e => key(e) === key(consumer))
    if (!edge) return true
    const node = nodes.get(edge.to)
    return !!node && node.name === item.package && semver.gt(node.version, item.version) && item.advisories.every(a => !semver.satisfies(node.version, a.range))
  })
}
export function matchesSelectedScope(before, probe, targetLocation, affectedConsumers) {
  const selected = new Set(affectedConsumers.map(key))
  const targetConsumers = before.edges.filter(e => e.to === targetLocation)
  const oldByKey = new Map(targetConsumers.map(e => [key(e), e]))
  const probeByKey = new Map(probe.edges.map(e => [key(e), e]))
  if (!selected.size || [...selected].some(consumerKey => !oldByKey.has(consumerKey))) return false
  return targetConsumers.every((old) => {
    const current = probeByKey.get(key(old))
    if (!current) return false
    const changed = current.to !== old.to || current.effectiveSpec !== old.effectiveSpec
    return selected.has(key(old)) ? changed : current.to === old.to && current.effectiveSpec === old.effectiveSpec
  })
}

function mergeRule(base, route, name, version, nodes, rootEdges, semver) {
  const location = route[0], n = nodes.get(location), selector = `${n.name}@${n.version}`
  const old = base[selector]
  let value
  if (old === undefined) value = {}
  else if (typeof old === 'string') value = { '.': old }
  else value = structuredClone(old)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported override scope')
  const rootEdge = rootEdges.find(e => e.to === location)
  if (rootEdge && !Object.hasOwn(value, '.')) value['.'] = `$${rootEdge.requestedName}`
  if (route.length > 1) value = mergeRule(value, route.slice(1), name, version, nodes, rootEdges, semver)
  else {
    const existing = typeof value[name] === 'string' ? value[name] : value[name]?.['.']
    if (existing && (!semver.validRange(existing) || !semver.satisfies(version, existing))) throw new Error('Unsupported existing override policy')
    const requirement = version.includes('+') ? `>=${version} <=${version}` : version
    value[name] = value[name] && typeof value[name] === 'object' ? { ...value[name], '.': requirement } : requirement
  }
  return { [selector]: value, ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== selector)) }
}

// Serializes an edited manifest with the original file's indentation, line endings and trailing newline.
function serializeManifest(manifest, original) {
  const text = original.toString()
  const indent = /\n([\t ]+)"/.exec(text)?.[1]
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return Buffer.from(JSON.stringify(manifest, null, indent).replaceAll('\n', newline) + (text.endsWith('\n') ? newline : ''))
}

// Every toolchain member the root declares moves to exactly the tested version in the field that declares it, and an
// existing @angular-devkit/core override follows. No other declaration or override is touched or added.
function toolchainManifest(manifest, choice) {
  const fields = ['dependencies', 'devDependencies']
  if (!fields.some(field => Object.hasOwn(manifest[field] || {}, choice.targetPackage))) throw new Error('Toolchain is not declared by the project')
  for (const name of TOOLCHAIN_MEMBERS) {
    const field = fields.find(f => Object.hasOwn(manifest[f] || {}, name))
    if (field) manifest[field][name] = choice.targetVersion
  }
  const overrides = manifest.overrides
  if (overrides && typeof overrides === 'object' && Object.hasOwn(overrides, '@angular-devkit/core')) {
    const override = overrides['@angular-devkit/core']
    if (typeof override === 'string') overrides['@angular-devkit/core'] = choice.targetVersion
    else if (override && typeof override === 'object' && typeof override['.'] === 'string') override['.'] = choice.targetVersion
    else throw new Error('Unsupported override scope')
  }
  return manifest
}

const DAY_MS = 86_400_000

// The release-age cutoff from npm configuration: never fewer than seven days, bounded by an explicit `before`.
function releaseCutoff(config, now = Date.now()) {
  const configured = Number(config.get('min-release-age') || 0)
  const before = config.get('before')
  const explicit = before ? new Date(before).getTime() : Infinity
  if (!Number.isFinite(configured) || Number.isNaN(explicit)) throw new Error('Invalid release-age policy')
  return Math.min(now - Math.max(7, configured) * DAY_MS, explicit)
}

// Phase 1 lands the ancestor on exactly the tested release (npm's named update, capped at that release's publication
// time). That cap would also hold back everything the new release brings in, so phase 2 removes those new or changed
// installations from the tree and lets npm resolve them again under the real cutoff: the newest releases that are old
// enough, with every other installation left untouched. No overrides, no manifest edits, no hand-edited lockfile.
async function landAncestor({ Arborist, opts, choice, releasedAt, cutoff, load }) {
  const current = new Map((await load()).nodes.map(n => [n.location, n]))
  const first = await new Arborist({ ...opts, before: new Date(Math.min(releasedAt, cutoff)) }).buildIdealTree({ update: { names: [choice.targetPackage] } })
  await first.meta.save()
  const stale = graph(first).nodes.filter(n => n.location && n.location !== choice.targetLocation && !equal(current.get(n.location), n)).map(n => n.location).sort((a, b) => a.length - b.length)
  if (!stale.length) return first
  const arborist = new Arborist({ ...opts, before: new Date(cutoff) })
  const virtual = await arborist.loadVirtual()
  for (const location of stale) {
    const node = virtual.inventory.get(location)
    if (node) node.parent = null
  }
  arborist.virtualTree = virtual
  const ideal = await arborist.buildIdealTree()
  await ideal.meta.save()
  return ideal
}

export async function resolveRequest(request) {
  const require = createRequire(path.join(request.npmPath, 'package.json'))
  const Arborist = require('@npmcli/arborist'), Config = require('@npmcli/config'), semver = require('semver')
  const { definitions, shorthands, flatten } = require('@npmcli/config/lib/definitions')
  const config = new Config({ npmPath: request.npmPath, definitions, shorthands, flatten, cwd: request.projectRoot, env: process.env, argv: [] })
  await config.load()
  config.validate()
  if (!config.valid) throw new Error('Invalid npm resolver configuration')
  const opts = { ...config.flat, path: request.root, ignoreScripts: true, audit: false, fund: false, preferOnline: true }
  delete opts.before
  delete opts.minReleaseAge
  const load = async () => graph(await new Arborist(opts).loadVirtual())
  const before = await load(), original = await readFile(path.join(request.root, 'package.json'))
  const snapshots = [], accepted = [], satisfied = []
  let nodes, rootEdges, parents
  // Scope probing follows the tree as it stands after earlier actions, which may have moved installations.
  const indexScope = (current) => {
    nodes = new Map(current.nodes.map(n => [n.location, n]))
    rootEdges = current.edges.filter(e => e.from === '')
    parents = new Map()
    for (const e of current.edges) {
      if (!parents.has(e.to)) parents.set(e.to, new Set())
      parents.get(e.to).add(e.from)
    }
  }
  indexScope(before)
  for (let choiceIndex = 0;
    choiceIndex < request.choices.length;
    choiceIndex++) {
    const choice = request.choices[choiceIndex], startFiles = await Promise.all(['package.json', 'package-lock.json'].map(n => readFile(path.join(request.root, n))))
    if (isToolchain(choice)) {
      // Later actions are judged against the tree the toolchain bump leaves, so it must be resolved first.
      if (choiceIndex !== 0) throw new Error('Toolchain choice must be resolved first')
      let after
      try {
        await writeFile(path.join(request.root, 'package.json'), serializeManifest(toolchainManifest(JSON.parse(startFiles[0]), choice), startFiles[0]))
        const tree = await new Arborist(opts).buildIdealTree()
        await tree.meta.save()
        after = graph(tree)
        verifyResolution(before, after, request.item, [choice], semver)
      }
      catch (error) {
        await Promise.all(['package.json', 'package-lock.json'].map((n, i) => writeFile(path.join(request.root, n), startFiles[i])))
        if (request.strict) throw error
        continue
      }
      accepted.push(choice)
      snapshots.push({ choiceIndex, graph: after, files: Object.fromEntries(await Promise.all(['package.json', 'package-lock.json'].map(async n => [n, (await readFile(path.join(request.root, n))).toString('base64')]))) })
      continue
    }
    if (isParent(choice)) {
      // npm's named update under the original declarations, capped at the tested release's publication time so
      // the ancestor lands on exactly that version. No overrides, no declaration edits.
      const restore = () => Promise.all(['package.json', 'package-lock.json'].map((n, i) => writeFile(path.join(request.root, n), startFiles[i])))
      const releasedAt = Date.parse(request.releaseTimes?.[`${choice.targetPackage}@${choice.targetVersion}`])
      const cutoff = releaseCutoff(config)
      if (!Number.isFinite(releasedAt) || releasedAt > cutoff) {
        // A release without a publication time, or younger than the policy allows, is never an ancestor candidate.
        if (request.strict) throw new Error('Ancestor release is not old enough under the release-age policy')
        continue
      }
      let after
      try {
        // A release npm cannot resolve (peer conflict, missing dependency release) is unsuitable, not a failed run.
        const tree = await landAncestor({ Arborist, opts, choice, releasedAt, cutoff, load })
        after = graph(tree)
        if (!(await readFile(path.join(request.root, 'package.json'))).equals(startFiles[0])) throw new Error('Ancestor update changed the manifest')
        verifyResolution(before, after, request.item, [...accepted, choice], semver)
      }
      catch (error) {
        await restore()
        if (request.strict) throw error
        continue
      }
      accepted.push(choice)
      snapshots.push({ choiceIndex, graph: after, files: Object.fromEntries(await Promise.all(['package.json', 'package-lock.json'].map(async n => [n, (await readFile(path.join(request.root, n))).toString('base64')]))) })
      continue
    }
    const scopeBefore = await load()
    indexScope(scopeBefore)
    // An action whose consumers an earlier ancestor upgrade already cleared stays in the plan: whether npm dedupes
    // is decided again at execution, where the executor skips it only if it is still satisfied.
    if (accepted.length && choiceSatisfied(scopeBefore, choice, request.item, semver)) {
      satisfied.push(choice)
      continue
    }
    const manifest = JSON.parse(startFiles[0])
    let finalManifest = startFiles[0], mutation
    if (choice.affectedConsumers.some(e => e.location === '')) {
      for (const e of choice.affectedConsumers.filter(e => e.location === '')) {
        const spec = manifest[e.type]?.[e.requestedName]
        if (!/^[~^]\s*\d/.test(spec)) throw new Error('Unsupported direct declaration')
        manifest[e.type][e.requestedName] = spec.trim()[0] + choice.targetVersion
      }
      finalManifest = serializeManifest(manifest, startFiles[0])
      mutation = structuredClone(manifest)
      for (const e of choice.affectedConsumers.filter(e => e.location === '')) mutation[e.type][e.requestedName] = choice.targetVersion.includes('+') ? `>=${choice.targetVersion} <=${choice.targetVersion}` : choice.targetVersion
    }
    else {
      let routes = choice.affectedConsumers.map(e => [e.location]), matched = false
      const attempted = new Set()
      for (let depth = 1;
        routes.length && depth <= nodes.size;
        depth++) {
        mutation = structuredClone(manifest)
        mutation.overrides = structuredClone(manifest.overrides || {})
        try {
          for (const route of routes) mutation.overrides = mergeRule(mutation.overrides, route, choice.targetPackage, choice.targetVersion, nodes, rootEdges, semver)
        }
        catch { break }
        const signature = JSON.stringify(mutation.overrides)
        if (attempted.has(signature)) break
        attempted.add(signature)
        await writeFile(path.join(request.root, 'package.json'), JSON.stringify(mutation))
        const probe = await load()
        if (matchesSelectedScope(scopeBefore, probe, request.item.targetLocation, choice.affectedConsumers)) {
          matched = true
          break
        }
        routes = routes.flatMap(route => [...(parents.get(route[0]) || [])].map(p => p === '' ? route : [p, ...route]))
        if (routes.length > 1024) break
      }
      if (!matched) {
        await writeFile(path.join(request.root, 'package.json'), startFiles[0])
        if (request.strict) throw new Error('Cannot express selected consumer scope')
        continue
      }
    }
    await writeFile(path.join(request.root, 'package.json'), JSON.stringify(mutation))
    let arb = new Arborist(opts), tree = await arb.buildIdealTree()
    await tree.meta.save()
    await writeFile(path.join(request.root, 'package.json'), finalManifest)
    arb = new Arborist(opts)
    tree = await arb.buildIdealTree()
    await tree.meta.save()
    const after = graph(tree)
    try {
      verifyResolution(before, after, request.item, [...accepted, choice], semver)
    }
    catch (error) {
      await Promise.all(['package.json', 'package-lock.json'].map((n, i) => writeFile(path.join(request.root, n), startFiles[i])))
      if (request.strict) throw error
      continue
    }
    accepted.push(choice)
    snapshots.push({ choiceIndex, graph: after, files: Object.fromEntries(await Promise.all(['package.json', 'package-lock.json'].map(async n => [n, (await readFile(path.join(request.root, n))).toString('base64')]))) })
  }
  const after = await load()
  return { schemaVersion: 1, choices: request.choices.filter(choice => accepted.includes(choice) || satisfied.includes(choice)), graph: after, before, snapshots, coverage: computeCoverage(before, after, request.item, semver), manifestChanged: !(await readFile(path.join(request.root, 'package.json'))).equals(original), freshAt: request.startedAt }
}
if (process.argv[2]) {
  try {
    process.stdout.write(JSON.stringify(await resolveRequest(JSON.parse(await readFile(process.argv[2], 'utf8')))))
  }
  catch {
    process.stderr.write('Dependency resolver failed; check registry access, npm configuration, and dependency constraints\n')
    process.exitCode = 1
  }
}
