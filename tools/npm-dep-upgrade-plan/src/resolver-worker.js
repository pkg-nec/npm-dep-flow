// Standalone worker: only npm's in-memory resolver and private lock serialization.
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
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
export function verifyResolution(before, after, item, choices, semver) {
  const oldNodes = new Map(before.nodes.map(n => [n.location, n])), nodes = new Map(after.nodes.map(n => [n.location, n]))
  const selected = new Map(choices.flatMap(c => c.affectedConsumers.map(e => [key(e), c])))
  const oldIncoming = before.edges.filter(e => e.to === item.targetLocation)
  for (const n of before.nodes) if (n.location && n.name !== item.package && !equal(n, nodes.get(n.location)) && !closure(before, [item.targetLocation]).has(n.location)) throw new Error('Unrelated parent installation changed')
  for (const old of before.edges) {
    const oldNode = oldNodes.get(old.to)
    if (oldNode?.name !== item.package) continue
    const current = after.edges.find(e => key(e) === key(old))
    const currentNode = nodes.get(current?.to)
    if (oldIncoming.includes(old)) {
      const choice = selected.get(key(old))
      if (!currentNode || currentNode.name !== item.package || !semver.validRange(old.rawSpec) || !semver.satisfies(currentNode.version, old.rawSpec)) throw new Error('Original consumer requirement not satisfied')
      if (choice ? currentNode.version !== choice.targetVersion : !equal(oldNode, currentNode)) throw new Error('Consumer resolved outside intended scope')
    }
    else if (oldNode?.name === item.package && !equal(oldNode, currentNode)) throw new Error('Another target installation changed')
  }
  const newTargets = oldIncoming.map(e => after.edges.find(x => key(x) === key(e))?.to).filter(x => x !== undefined)
  const allowed = new Set([...closure(before, [item.targetLocation]), ...closure(after, newTargets)])
  for (const n of [...before.nodes, ...after.nodes]) if (n.location && !equal(oldNodes.get(n.location), nodes.get(n.location)) && !allowed.has(n.location)) throw new Error('Unrelated installation changed')
  for (const e of after.edges) if (e.to === null ? !e.optional : e.valid === false) throw new Error('Invalid dependency graph after resolution')
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
  let value = old === undefined ? {} : typeof old === 'string' ? { '.': old } : structuredClone(old)
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
  const snapshots = [], accepted = [], nodes = new Map(before.nodes.map(n => [n.location, n]))
  const rootEdges = before.edges.filter(e => e.from === ''), parents = new Map()
  for (const e of before.edges) {
    if (!parents.has(e.to)) parents.set(e.to, new Set())
    parents.get(e.to).add(e.from)
  }
  for (let choiceIndex = 0;
    choiceIndex < request.choices.length;
    choiceIndex++) {
    const choice = request.choices[choiceIndex], startFiles = await Promise.all(['package.json', 'package-lock.json'].map(n => readFile(path.join(request.root, n))))
    const scopeBefore = await load()
    const manifest = JSON.parse(startFiles[0])
    let finalManifest = startFiles[0], mutation
    if (choice.affectedConsumers.some(e => e.location === '')) {
      for (const e of choice.affectedConsumers.filter(e => e.location === '')) {
        const spec = manifest[e.type]?.[e.requestedName]
        if (!/^[~^]\s*\d/.test(spec)) throw new Error('Unsupported direct declaration')
        manifest[e.type][e.requestedName] = spec.trim()[0] + choice.targetVersion
      }
      const indent = /\n([\t ]+)"/.exec(startFiles[0].toString())?.[1]
      const newline = startFiles[0].includes('\r\n') ? '\r\n' : '\n'
      finalManifest = Buffer.from(JSON.stringify(manifest, null, indent).replaceAll('\n', newline) + (startFiles[0].toString().endsWith('\n') ? newline : ''))
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
  const after = await load(), clearedConsumers = [], remainingConsumers = [], afterNodes = new Map(after.nodes.map(n => [n.location, n]))
  for (const e of before.edges.filter(e => e.to === request.item.targetLocation)) {
    const current = after.edges.find(x => key(x) === key(e)), node = afterNodes.get(current?.to)
    const safe = node && semver.gt(node.version, request.item.version) && request.item.advisories.every(a => !semver.satisfies(node.version, a.range))
    ;
    (safe ? clearedConsumers : remainingConsumers).push({ location: e.from, requestedName: e.requestedName, type: e.type })
  }
  return { schemaVersion: 1, choices: accepted, graph: after, before, snapshots, coverage: { resolution: !clearedConsumers.length ? 'none' : remainingConsumers.length ? 'partial' : 'complete', clearedConsumers, remainingConsumers }, manifestChanged: !(await readFile(path.join(request.root, 'package.json'))).equals(original), freshAt: request.startedAt }
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
