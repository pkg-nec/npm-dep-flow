import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './process.js'
import { assertCleanWorkingTree, assertGitState, commitUpgrade, readDependencyFiles, runGit } from './git.js'
import { recordOwnedFiles } from './recovery.js'
import { readCandidateAdvisories, readCatalog } from './registry.js'
import { loadGraph } from './graph.js'
import { verifyFinalSecurity } from './verify.js'
import { consumerKey, verifyCoverage } from './coverage.js'
import { checkManifestChanges, selectLineRelease, setLineOverrides } from './angular-line.js'
import { fail } from './errors.js'

const MIGRATIONS = 'migrations.json'
const trimLine = s => s.replace(/\r?\n$/, '')
// Arguments are fixed tokens, semantic versions and npm-context flags; anything else is refused before a shell sees it.
const SHELL_SAFE = /^[\w@./:=+-]+$/

// Windows runs the npm/npx .cmd launchers through a shell as one command string; Unix-like systems spawn directly.
function launch(run, platform, stage, name, args, options) {
  if (platform !== 'win32') return run(name, args, { ...options, shell: false })
  if (args.some(arg => !SHELL_SAFE.test(arg))) fail('UNSAFE_ARGUMENT', stage, `Refusing to pass a shell metacharacter to ${name}.cmd`)
  return run(`${name}.cmd ${args.join(' ')}`, [], { ...options, shell: true })
}

async function exists(file) {
  try {
    await lstat(file)
    return true
  }
  catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Every changed path in the repository except installed packages, which this operation never inspects or restores.
async function changedPaths(guard) {
  const tokens = (await runGit(guard.repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ':(exclude,glob)**/node_modules/**'])).split('\0')
  const entries = []
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) continue
    const code = tokens[i].slice(0, 2)
    entries.push({ code, file: tokens[i].slice(3) })
    // Renames and copies list their source path as the next token.
    if (/[RC]/.test(code)) entries.push({ code, file: tokens[++i] })
  }
  return entries
}

async function expectChanged(guard, names, code, stage) {
  const expected = names.map(name => (guard.projectPrefix ? `${guard.projectPrefix}/${name}` : name))
  const entries = await changedPaths(guard)
  const unexpected = entries.filter(entry => entry.code !== ' M' || !expected.includes(entry.file))
  if (unexpected.length || entries.length !== expected.length) {
    const listed = unexpected.length ? unexpected.map(entry => entry.file).join(', ') : `missing changes to ${expected.join(', ')}`
    fail(code, stage, `Unexpected working tree state: ${listed}`)
  }
}

function parseJson(bytes, name) {
  try {
    return JSON.parse(bytes)
  }
  catch { fail('INVALID_PROJECT', 'verification', `Invalid ${name}`) }
}

function verifyManifest(line, beforeManifest, afterText, version) {
  const after = parseJson(afterText, 'package.json')
  checkManifestChanges(line, beforeManifest, after, version)
  const field = ['devDependencies', 'dependencies'].find(name => Object.hasOwn(beforeManifest[name] || {}, line.anchor))
  if (!field || after[field]?.[line.anchor] !== version) fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', `${line.anchor} was not migrated to ${version}`)
}

const entryName = (location, entry) => entry.name || location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
const sameEntry = (location, a, b) => !!a && !!b && entryName(location, a) === entryName(location, b) && a.version === b.version && a.resolved === b.resolved && a.integrity === b.integrity

// Versions the lockfile gained, and the versions those changes replaced or removed.
function lockDiff(before, after) {
  const changedVersions = new Map(), replacedVersions = new Map()
  const add = (map, name, version) => map.set(name, [...new Set([...(map.get(name) || []), version])])
  for (const [location, entry] of Object.entries(after)) if (location && !entry.link && entry.version && !sameEntry(location, before[location], entry)) add(changedVersions, entryName(location, entry), entry.version)
  for (const [location, entry] of Object.entries(before)) if (location && !entry.link && entry.version && !sameEntry(location, entry, after[location])) add(replacedVersions, entryName(location, entry), entry.version)
  return { changedVersions, replacedVersions }
}

// Fresh security for every changed version, then the finding's own consumers must be cleared in the new lockfile.
async function verifyFreshAudit({ line, item, choice, version, before, after, beforeGraph, advisories, context, root, adapters }) {
  const diff = lockDiff(parseJson(before['package-lock.json'], 'package-lock.json').packages || {}, parseJson(after['package-lock.json'], 'package-lock.json').packages || {})
  await verifyFinalSecurity({ item }, { version }, diff, { ...context, projectRoot: root }, adapters)
  const afterGraph = await (adapters.loadGraph || loadGraph)(root)
  const evidence = { item, graph: beforeGraph, incoming: beforeGraph.edges.filter(edge => edge.to === item.targetLocation), auditRows: [{ package: item.package, version: item.version, advisories: advisories.get(item.package) || [] }] }
  const cleared = new Set(verifyCoverage(evidence, afterGraph).clearedConsumers.map(consumerKey))
  if (choice.affectedConsumers.some(consumer => !cleared.has(consumerKey(consumer)))) fail(`${line.key.toUpperCase()}_NOT_CLEARED`, 'verification', `Migrating to ${version} did not clear the finding's affected consumers`)
}

async function assertSameCommit(guard, name) {
  if (trimLine(await runGit(guard.repoRoot, ['rev-parse', 'HEAD'])) !== guard.head) fail('CONCURRENT_CHANGE', 'recovery', `Git HEAD changed during the ${name} migration`)
  const branch = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: guard.repoRoot })
  if (branch.code || trimLine(branch.stdout) !== guard.branch) fail('CONCURRENT_CHANGE', 'recovery', `Git branch changed during the ${name} migration`)
}

const DEPENDENCY_FILES = ['package.json', 'package-lock.json']
const sameBytes = (a, b) => (a === null ? b === null : !!b && a.equals(b))

async function readOrNull(file) {
  try {
    return await readFile(file)
  }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// The run owns only the two dependency files (as it last wrote or observed them) and the migrations.json it may have
// caused. Anything else that changed, whether nx, npm or the user changed it, is left in place and named.
async function revertWorkingTree(guard, owned, name) {
  await assertSameCommit(guard, name)
  const left = []
  for (const name of DEPENDENCY_FILES) {
    const file = path.join(guard.root, name)
    const current = await readOrNull(file)
    if (sameBytes(current, guard.originalFiles[name])) continue
    if (sameBytes(current, owned[name])) await writeFile(file, guard.originalFiles[name])
    else left.push(`${guard.projectPrefix ? `${guard.projectPrefix}/` : ''}${name} (changed outside this run)`)
  }
  // migrations.json was absent at the start, so one present now was created during the run; remove it even when ignored.
  await rm(path.join(guard.root, MIGRATIONS), { force: true })
  if (!left.length) guard.ownedFiles = { ...guard.originalFiles }
  const restored = new Set(guard.dependencyPaths)
  left.push(...(await changedPaths(guard)).map(entry => entry.file).filter(file => !restored.has(file)))
  if (left.length) fail('RECOVERY_INCOMPLETE', 'recovery', `left in place for you to inspect: ${[...new Set(left)].join(', ')}`)
}

// Migrates one Angular line (its anchor drives nx migrate, release age and the commit) in the real project.
export async function migrateLine({ line, guard, project, item, choice, context, options = {}, adapters = {} }) {
  const run = adapters.run || runProcess
  const platform = adapters.platform || process.platform
  const select = adapters.selectLineRelease || selectLineRelease
  const verify = adapters.verifyFreshAudit || verifyFreshAudit
  const commit = adapters.commitUpgrade || commitUpgrade
  const root = project.root
  const io = { cwd: root, onStderr: chunk => adapters.stderr?.write(chunk) }
  // The dependency files as this run last wrote or observed them; revert restores a file only while it still matches.
  const owned = { ...guard.originalFiles }
  const observe = async () => {
    for (const name of DEPENDENCY_FILES) owned[name] = await readOrNull(path.join(root, name))
  }
  const step = async (name, args, extra = {}) => {
    try {
      return await launch(run, platform, line.name, name, args, { ...io, ...extra })
    }
    finally { await observe() }
  }
  await assertCleanWorkingTree(guard, line.name)
  await assertGitState(guard, line.name)
  if (await exists(path.join(root, MIGRATIONS))) fail('GIT_PRECONDITION', 'git', `${MIGRATIONS} already exists; finish or remove the previous migration first`)
  const catalog = await (adapters.readCatalog || readCatalog)(root, line.anchor, context)
  const queried = new Map([[line.anchor, catalog.versions]])
  if (item) queried.set(item.package, [...new Set([...(queried.get(item.package) || []), item.version])])
  const advisories = await (adapters.readCandidateAdvisories || readCandidateAdvisories)(queried, context)
  const release = select(line, choice, { ...catalog, minAgeDays: context.minAgeDays, cutoffMs: context.cutoffMs }, advisories.get(line.anchor) || [], Date.now())
  const version = release.version
  const before = guard.originalFiles
  const beforeManifest = parseJson(before['package.json'], 'package.json')
  const beforeGraph = item ? await (adapters.loadGraph || loadGraph)(root) : null
  const finding = beforeGraph?.nodes.get(item.targetLocation)
  if (item && (!finding || finding.name !== item.package || finding.version !== item.version)) fail('STALE_RECOMMENDATION', 'evidence', 'Target installation changed; recommendation is stale')
  try {
    guard.installedTreeMayHaveChanged = true
    if ((await step('npm', ['ci', ...context.installArgs.slice(1)])).code) fail('INSTALL_FAILED', 'clean-install', 'npm ci failed; inspect npm diagnostics')
    await expectChanged(guard, [], 'LOCK_OUT_OF_SYNC', 'clean-install')
    const installed = await readDependencyFiles(root)
    for (const name of Object.keys(installed)) if (!installed[name].equals(before[name])) fail('LOCK_OUT_OF_SYNC', 'clean-install', `npm ci changed ${name}; package.json and package-lock.json are out of sync`)
    // npx starts nx, which may install packages itself; scripts stay disabled for anything it runs.
    if ((await step('npx', ['--no', 'nx', 'migrate', `${line.anchor}@${version}`], { env: { ...process.env, npm_config_ignore_scripts: 'true' } })).code) fail('MIGRATION_FAILED', 'migration', 'nx migrate failed; inspect nx diagnostics')
    if (await exists(path.join(root, MIGRATIONS))) fail('MIGRATIONS_GENERATED', 'migration', `nx migrate generated ${MIGRATIONS}; migrate to ${version} manually`)
    await expectChanged(guard, ['package.json'], 'UNEXPECTED_FILE_CHANGE', 'migration')
    const manifestPath = path.join(root, 'package.json')
    const migrated = await readFile(manifestPath, 'utf8')
    verifyManifest(line, beforeManifest, migrated, version)
    const overridden = setLineOverrides(line, migrated, version)
    if (overridden !== null) {
      owned['package.json'] = Buffer.from(overridden)
      await writeFile(manifestPath, overridden)
    }
    const install = args => step('npm', args)
    if ((await install(context.installArgs)).code) {
      if ((await install([...context.installArgs, '-f'])).code) fail('INSTALL_FAILED', 'install', 'npm install failed even with -f; inspect npm diagnostics')
      if ((await install(context.installArgs)).code) fail('INSTALL_FAILED', 'install', 'npm install failed again after the -f retry; inspect npm diagnostics')
    }
    await expectChanged(guard, ['package.json', 'package-lock.json'], 'UNEXPECTED_FILE_CHANGE', 'install')
    const after = await readDependencyFiles(root)
    verifyManifest(line, beforeManifest, after['package.json'].toString('utf8'), version)
    if (parseJson(after['package-lock.json'], 'package-lock.json').packages?.[choice.targetLocation]?.version !== version) fail('TARGET_MISMATCH', 'verification', `${line.anchor} did not install at ${version}`)
    await verify({ line, item, choice, version, before, after, beforeGraph, advisories, context, root, adapters })
    await recordOwnedFiles(guard, after)
    const committed = await commit(guard, after, { package: line.anchor, oldVersion: choice.currentVersion, newVersion: version, strategy: line.strategy, description: line.description(version) }, options)
    guard.head = committed.hash
    guard.originalFiles = { ...after }
    guard.ownedFiles = { ...after }
    return { commit: committed, action: { ...choice, targetVersion: version, outcome: 'applied', targetLocations: [choice.targetLocation], releasedAt: release.releasedAt, supportingChanges: [] } }
  }
  catch (error) {
    // A commit Git already created is never undone; the caller reports it.
    if (error.createdCommit) throw error
    error.stage ??= line.name
    const separator = /[.!?]$/.test(error.message) ? ' ' : '. '
    try {
      await revertWorkingTree(guard, owned, line.name)
      error.message += `${separator}Working tree restored.`
      error.workingTreeRestored = true
    }
    catch (recovery) {
      error.message += `${separator}Working tree could not be fully restored: ${recovery.message}; inspect Git state.`
      error.workingTreeRestored = false
    }
    throw error
  }
}
