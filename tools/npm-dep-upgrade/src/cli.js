import { executeActions } from './transaction.js'
import { commitSnapshots } from './commit-sequence.js'
import { consumerKey, verifyCoverage, verifyInstalledGraph } from './coverage.js'
import { runDebug } from './debug.js'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseArgs } from './args.js'
import { resolveOptions } from './config.js'
import { preflightGit, assertGitState, readDependencyFiles, commitUpgrade } from './git.js'
import { restoreDependencyFiles } from './recovery.js'
import { loadProject } from './project.js'
import { loadGraph } from './graph.js'
import { clearPlannerCache, readPlanner, selectItem, splitToolchain } from './planner.js'
import { migrateToolchain } from './toolchain-migration.js'
import { readEvidence } from './evidence.js'
import { loadNpmContext } from './npm-context.js'
import { readCatalog, readCandidateAdvisories } from './registry.js'
import { selectCandidate } from './candidates.js'
import { buildMutation, writeMutation } from './mutation.js'
import { installProject } from './installer.js'
import { createStagingProject } from './staging.js'
import { verifyGraph, verifyFinalSecurity } from './verify.js'
import { renderJson, renderMarkdown } from './report.js'

const toolRoot = fileURLToPath(new URL('../', import.meta.url))
const defaults = { clearPlannerCache, migrateToolchain, executeActions, commitSnapshots, preflightGit, assertGitState, loadProject, loadGraph, readPlanner, readEvidence, loadNpmContext, readCatalog, readCandidateAdvisories, selectCandidate, buildMutation, writeMutation, installProject, createStagingProject, verifyGraph, verifyFinalSecurity, commitUpgrade }
export async function main(argv, io = process, overrides = {}) {
  try {
    const options = await resolveOptions(parseArgs(argv))
    return await runDebug(options.debug, io, () => mainWithDebug(options, io, overrides))
  }
  catch (error) {
    io.stderr.write(`npm-dep-upgrade: ${error.stage || 'arguments'}: ${error.message}\n`)
    return 1
  }
}

async function mainWithDebug(options, io = process, overrides = {}) {
  const d = { ...defaults, ...overrides }
  let guard, staging, toolchainCommit, mutated = false, committing = false, stage = 'arguments'
  try {
    if (options.action !== 'upgrade') {
      const pkg = JSON.parse(await readFile(path.join(toolRoot, 'package.json'), 'utf8'))
      const help = `${pkg.name} v${pkg.version}

Usage: npm-dep-upgrade [project] <id-or-prefix> [options]

Arguments:
  project                           Project directory (default: ., the caller's current directory)
  id-or-prefix                      Required planner item ID or unique prefix

Options:
  --package <name>                  Filter the item ID by exact package name
  --format markdown|json            Output format (default: markdown)
  --config <path>                   Load an explicit JSON configuration file
  --module <name>                   Module scope used in the commit subject
  --commit-message-template <text>  Customize the commit subject using placeholders
  --git-commit-arg=<arg>            Add a supported Git commit argument (repeatable)
  --clear-git-commit-args           Replace configured Git arguments with an empty list
  --clear-cache                     Delete analysis caches (planner, audit, paths, versions); with no item ID, only clear
  --debug                           Log external actions and cache decisions to stderr
  --no-debug                        Disable debug logging, overriding configuration
  --version                         Show version and tool directory
  --help                            Show this help

Upgrade one partial or complete planner installation in the selected project and commit the verified dependency files.
`
      io.stdout.write(options.action === 'version' ? `${pkg.name} v${pkg.version}\nLocation: ${toolRoot}\n` : help)
      return 0
    }
    if (options.clearOnly) {
      stage = 'planner'
      await d.clearPlannerCache(process.cwd())
      return 0
    }
    stage = 'preflight'
    guard = await d.preflightGit(options.projectPath)
    let project = await d.loadProject(guard.root)
    stage = 'planner'
    const item = selectItem(await d.readPlanner(project.root, undefined, { clearCache: options.clearCache === true }), options.selector, options.packageName)
    stage = 'configuration'
    const context = await d.loadNpmContext(project.root)
    context.projectRoot = project.root
    const { toolchain, rest } = splitToolchain(item)
    const done = { actions: [], commits: [] }
    if (toolchain) {
      // The toolchain migration runs in the real project and commits first; it reverts its own changes on failure.
      stage = 'toolchain'
      const migrated = await d.migrateToolchain({ guard, project, item, choice: toolchain, context, options, adapters: { stderr: io.stderr, loadGraph: d.loadGraph, readCatalog: d.readCatalog, readCandidateAdvisories: d.readCandidateAdvisories, commitUpgrade: d.commitUpgrade } })
      toolchainCommit = migrated.commit
      done.actions.push(migrated.action)
      done.commits.push({ ...migrated.commit, actionIndex: 0 })
      stage = 'project'
      project = await d.loadProject(guard.root)
      const graph = await d.loadGraph(project.root)
      const target = graph.nodes.get(item.targetLocation)
      if (!rest.choices.length || !target || target.name !== item.package || target.version !== item.version) {
        for (const choice of rest.choices) {
          const targetLocations = [...new Set(choice.affectedConsumers.map(consumer => graph.edges.find(edge => consumerKey(edge) === consumerKey(consumer))?.to).filter(Boolean))]
          done.actions.push({ ...choice, outcome: 'already-satisfied', targetLocations, releasedAt: null, supportingChanges: [] })
        }
        const result = { schemaVersion: 3, id: item.id, package: item.package, oldVersion: item.version, targetLocation: item.targetLocation, resolution: 'complete', ...done }
        io.stdout.write(options.format === 'json' ? renderJson(result) : renderMarkdown(result))
        return 0
      }
    }
    stage = 'evidence'
    const evidence = await d.readEvidence(project, rest)
    stage = 'configuration'
    staging = await d.createStagingProject(project, context)
    stage = 'resolution'
    const transaction = await d.executeActions(project, rest, evidence, context, { ...d, staging })
    const installContext = current => ({ ...current, installArgs: ['ci', ...current.installArgs.slice(1)] })
    const verifySnapshot = async (snapshot, root, currentContext) => {
      await d.installProject(root, installContext(currentContext), { stderr: io.stderr })
      const files = await readDependencyFiles(root)
      for (const name of Object.keys(files)) if (!files[name].equals(snapshot.files[name])) throw new Error(`npm changed verified dependency file: ${name}`)
      await d.verifyFinalSecurity(evidence, snapshot.candidate, snapshot, { ...currentContext, projectRoot: root })
      const installed = await d.loadGraph(root, { actual: true })
      verifyInstalledGraph(snapshot.graph, installed)
      const coverage = verifyCoverage(evidence, installed)
      for (const expected of snapshot.graph.edges.filter(edge => evidence.incoming.some(original => original.from === edge.from && original.requestedName === edge.requestedName && original.type === edge.type))) {
        const actual = installed.edges.find(edge => edge.from === expected.from && edge.requestedName === expected.requestedName && edge.type === expected.type)
        const node = installed.nodes.get(actual?.to), target = snapshot.graph.nodes.get(expected.to)
        if (!node || !target || node.name !== target.name || node.version !== target.version) throw new Error('Installed consumer differs from verified dependency graph')
      }
      return coverage
    }
    stage = 'verification'
    for (const snapshot of transaction.snapshots) {
      for (const [name, bytes] of Object.entries(snapshot.files)) await writeFile(path.join(staging.root, name), bytes)
      await verifySnapshot(snapshot, staging.root, staging.context)
    }
    await d.assertGitState(guard, 'before-publish')
    stage = 'commit'
    mutated = true
    committing = true
    const commits = await d.commitSnapshots(guard, transaction.snapshots, transaction.actions, context, options, { commitUpgrade: d.commitUpgrade, completedCommits: done.commits, prepareSnapshot: async (snapshot) => {
      guard.installedTreeMayHaveChanged = true
      await verifySnapshot(snapshot, project.root, context)
    } })
    // Staged action indexes refer to the remaining choices; the toolchain action, when present, comes first.
    const offset = done.actions.length
    const result = { schemaVersion: 3, id: item.id, package: item.package, oldVersion: item.version, targetLocation: item.targetLocation, resolution: transaction.coverage.resolution, actions: [...done.actions, ...transaction.actions], commits: [...done.commits, ...commits.map(commit => ({ ...commit, actionIndex: commit.actionIndex + offset }))] }
    io.stdout.write(options.format === 'json' ? renderJson(result) : renderMarkdown(result))
    return 0
  }
  catch (error) {
    let recovery = ''
    // A committed toolchain migration is kept; the commit sequence lists it itself once it has committed something.
    if (toolchainCommit && !error.committed?.length) error.message += `; completed commits: ${toolchainCommit.hash}.`
    if (mutated && (!committing || (error.committed && error.committed.length === 0))) {
      try {
        const result = await restoreDependencyFiles(guard)
        recovery = ` Dependency files restored.${result.installedTreeMayHaveChanged ? ' node_modules may have changed.' : ''}`
      }
      catch (e) { recovery = ` Recovery could not restore dependency files: ${e.message}. node_modules may have changed.` }
    }
    else if (committing) recovery = ' Verified dependency changes may remain uncommitted; inspect Git state.'
    else if (toolchainCommit) recovery = ' Dependency files were not changed after the toolchain commit.'
    else if (staging) recovery = ' Original dependency files were not changed by this operation.'
    io.stderr.write(`npm-dep-upgrade: ${error.stage || stage}: ${error.message}${recovery}\n`)
    return 1
  }
  finally {
    if (staging) await staging.cleanup().catch(() => io.stderr.write('npm-dep-upgrade: could not remove private staging directory\n'))
  }
}
