import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './process.js'
import { assertCleanWorkingTree, assertGitState, commitUpgrade, readDependencyFiles, runGit } from './git.js'
import { recordOwnedFiles } from './recovery.js'
import { readCandidateAdvisories, readCatalog } from './registry.js'
import { loadGraph } from './graph.js'
import { verifyFinalSecurity } from './verify.js'
import { consumerKey, verifyCoverage } from './coverage.js'
import { checkManifestChanges, selectToolchainRelease, setDevkitOverride } from './toolchain.js'
import { TOOLCHAIN_STRATEGY } from './model.js'
import { fail } from './errors.js'

const CLI = '@angular/cli'
const MIGRATIONS = 'migrations.json'
const line = s => s.replace(/\r?\n$/, '')
// Arguments are fixed tokens, semantic versions and npm-context flags; anything else is refused before a shell sees it.
const SHELL_SAFE = /^[\w@./:=+-]+$/

// Windows runs the npm/npx .cmd launchers through a shell as one command string; Unix-like systems spawn directly.
function launch(run, platform, name, args, options) {
  if (platform !== 'win32') return run(name, args, { ...options, shell: false })
  if (args.some(arg => !SHELL_SAFE.test(arg))) fail('UNSAFE_ARGUMENT', 'toolchain', `Refusing to pass a shell metacharacter to ${name}.cmd`)
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

function verifyManifest(beforeManifest, afterText, version) {
  const after = parseJson(afterText, 'package.json')
  checkManifestChanges(beforeManifest, after, version)
  const field = ['devDependencies', 'dependencies'].find(name => Object.hasOwn(beforeManifest[name] || {}, CLI))
  if (!field || after[field]?.[CLI] !== version) fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', `${CLI} was not migrated to ${version}`)
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
async function verifyFreshAudit({ item, choice, version, before, after, beforeGraph, advisories, context, root, adapters }) {
  const diff = lockDiff(parseJson(before['package-lock.json'], 'package-lock.json').packages || {}, parseJson(after['package-lock.json'], 'package-lock.json').packages || {})
  await verifyFinalSecurity({ item }, { version }, diff, { ...context, projectRoot: root }, adapters)
  const afterGraph = await (adapters.loadGraph || loadGraph)(root)
  const evidence = { item, graph: beforeGraph, incoming: beforeGraph.edges.filter(edge => edge.to === item.targetLocation), auditRows: [{ package: item.package, version: item.version, advisories: advisories.get(item.package) || [] }] }
  const cleared = new Set(verifyCoverage(evidence, afterGraph).clearedConsumers.map(consumerKey))
  if (choice.affectedConsumers.some(consumer => !cleared.has(consumerKey(consumer)))) fail('TOOLCHAIN_NOT_CLEARED', 'verification', `Migrating to ${version} did not clear the finding's affected consumers`)
}

async function assertSameCommit(guard) {
  if (line(await runGit(guard.repoRoot, ['rev-parse', 'HEAD'])) !== guard.head) fail('CONCURRENT_CHANGE', 'recovery', 'Git HEAD changed during the toolchain migration')
  const branch = await runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: guard.repoRoot })
  if (branch.code || line(branch.stdout) !== guard.branch) fail('CONCURRENT_CHANGE', 'recovery', 'Git branch changed during the toolchain migration')
}

async function literalGit(repoRoot, args) {
  const r = await runProcess('git', args, { cwd: repoRoot, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } })
  if (r.code) fail('GIT_ERROR', 'recovery', `git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
}

// The tree was clean when the migration started, so every listed path was changed by this run. Restore only those
// paths; HEAD, the branch and node_modules are never touched.
async function revertWorkingTree(guard) {
  await assertSameCommit(guard)
  for (const { code, file } of await changedPaths(guard)) {
    if (file.split('/').includes('node_modules')) continue
    const tracked = !(await runProcess('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: guard.repoRoot })).code
    if (tracked) await literalGit(guard.repoRoot, ['checkout', 'HEAD', '--', file])
    else {
      if (code[0] !== '?' && code[0] !== ' ') await literalGit(guard.repoRoot, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', file])
      await rm(path.join(guard.repoRoot, file), { force: true })
    }
  }
  // migrations.json was absent at the start; remove it even when Git ignores it.
  await rm(path.join(guard.root, MIGRATIONS), { force: true })
  const left = await changedPaths(guard)
  if (left.length) fail('RECOVERY_INCOMPLETE', 'recovery', `Paths remain changed: ${left.map(entry => entry.file).join(', ')}`)
  guard.ownedFiles = { ...guard.originalFiles }
}

export async function migrateToolchain({ guard, project, item, choice, context, options = {}, adapters = {} }) {
  const run = adapters.run || runProcess
  const platform = adapters.platform || process.platform
  const select = adapters.selectToolchainRelease || selectToolchainRelease
  const verify = adapters.verifyFreshAudit || verifyFreshAudit
  const commit = adapters.commitUpgrade || commitUpgrade
  const root = project.root
  const io = { cwd: root, onStderr: chunk => adapters.stderr?.write(chunk) }
  await assertCleanWorkingTree(guard)
  await assertGitState(guard, 'toolchain')
  if (await exists(path.join(root, MIGRATIONS))) fail('GIT_PRECONDITION', 'git', `${MIGRATIONS} already exists; finish or remove the previous migration first`)
  const catalog = await (adapters.readCatalog || readCatalog)(root, CLI, context)
  const queried = new Map([[CLI, catalog.versions]])
  if (item) queried.set(item.package, [...new Set([...(queried.get(item.package) || []), item.version])])
  const advisories = await (adapters.readCandidateAdvisories || readCandidateAdvisories)(queried, context)
  const release = select(choice, { ...catalog, minAgeDays: context.minAgeDays, cutoffMs: context.cutoffMs }, advisories.get(CLI) || [], Date.now())
  const version = release.version
  const before = guard.originalFiles
  const beforeManifest = parseJson(before['package.json'], 'package.json')
  const beforeGraph = item ? await (adapters.loadGraph || loadGraph)(root) : null
  const finding = beforeGraph?.nodes.get(item.targetLocation)
  if (item && (!finding || finding.name !== item.package || finding.version !== item.version)) fail('STALE_RECOMMENDATION', 'evidence', 'Target installation changed; recommendation is stale')
  try {
    guard.installedTreeMayHaveChanged = true
    if ((await launch(run, platform, 'npm', ['ci', ...context.installArgs.slice(1)], io)).code) fail('INSTALL_FAILED', 'clean-install', 'npm ci failed; inspect npm diagnostics')
    await expectChanged(guard, [], 'LOCK_OUT_OF_SYNC', 'clean-install')
    const installed = await readDependencyFiles(root)
    for (const name of Object.keys(installed)) if (!installed[name].equals(before[name])) fail('LOCK_OUT_OF_SYNC', 'clean-install', `npm ci changed ${name}; package.json and package-lock.json are out of sync`)
    if ((await launch(run, platform, 'npx', ['--no', 'nx', 'migrate', `${CLI}@${version}`], io)).code) fail('MIGRATION_FAILED', 'migration', 'nx migrate failed; inspect nx diagnostics')
    if (await exists(path.join(root, MIGRATIONS))) fail('MIGRATIONS_GENERATED', 'migration', `nx migrate generated ${MIGRATIONS}; migrate to ${version} manually`)
    await expectChanged(guard, ['package.json'], 'UNEXPECTED_FILE_CHANGE', 'migration')
    const manifestPath = path.join(root, 'package.json')
    const migrated = await readFile(manifestPath, 'utf8')
    verifyManifest(beforeManifest, migrated, version)
    const overridden = setDevkitOverride(migrated, version)
    if (overridden !== null) await writeFile(manifestPath, overridden)
    const install = args => launch(run, platform, 'npm', args, io)
    if ((await install(context.installArgs)).code) {
      if ((await install([...context.installArgs, '-f'])).code) fail('INSTALL_FAILED', 'install', 'npm install failed even with -f; inspect npm diagnostics')
      if ((await install(context.installArgs)).code) fail('INSTALL_FAILED', 'install', 'npm install failed again after the -f retry; inspect npm diagnostics')
    }
    await expectChanged(guard, ['package.json', 'package-lock.json'], 'UNEXPECTED_FILE_CHANGE', 'install')
    const after = await readDependencyFiles(root)
    verifyManifest(beforeManifest, after['package.json'].toString('utf8'), version)
    if (parseJson(after['package-lock.json'], 'package-lock.json').packages?.[choice.targetLocation]?.version !== version) fail('TARGET_MISMATCH', 'verification', `${CLI} did not install at ${version}`)
    await verify({ item, choice, version, before, after, beforeGraph, advisories, context, root, adapters })
    await recordOwnedFiles(guard, after)
    const committed = await commit(guard, after, { package: CLI, oldVersion: choice.currentVersion, newVersion: version, strategy: TOOLCHAIN_STRATEGY, description: `migrate Angular toolchain to ${version}` }, options)
    guard.head = committed.hash
    guard.originalFiles = { ...after }
    guard.ownedFiles = { ...after }
    return { commit: committed, action: { ...choice, targetVersion: version, outcome: 'applied', targetLocations: [choice.targetLocation], releasedAt: release.releasedAt, supportingChanges: [] } }
  }
  catch (error) {
    // A commit Git already created is never undone; the caller reports it.
    if (error.createdCommit) throw error
    error.stage ??= 'toolchain'
    try {
      await revertWorkingTree(guard)
      error.message += ' Working tree restored.'
      error.workingTreeRestored = true
    }
    catch (recovery) {
      error.message += ` Working tree could not be restored: ${recovery.message}; inspect Git state.`
      error.workingTreeRestored = false
    }
    throw error
  }
}
