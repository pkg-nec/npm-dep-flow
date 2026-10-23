import { executeActions } from './transaction.js'
import { commitSnapshots } from './commit-sequence.js'
import { verifyCoverage } from './coverage.js'
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
import { readPlanner, selectItem } from './planner.js'
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
const defaults = { executeActions, commitSnapshots, preflightGit, assertGitState, loadProject, loadGraph, readPlanner, readEvidence, loadNpmContext, readCatalog, readCandidateAdvisories, selectCandidate, buildMutation, writeMutation, installProject, createStagingProject, verifyGraph, verifyFinalSecurity, commitUpgrade }
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
  let guard, staging, mutated = false, committing = false, stage = 'arguments'
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
  --debug                           Log external actions and cache decisions to stderr
  --no-debug                        Disable debug logging, overriding configuration
  --version                         Show version and tool directory
  --help                            Show this help

Upgrade one partial or complete planner installation in the selected project and commit the verified dependency files.
`
      io.stdout.write(options.action === 'version' ? `${pkg.name} v${pkg.version}\nLocation: ${toolRoot}\n` : help)
      return 0
    }
    stage = 'preflight'
    guard = await d.preflightGit(options.projectPath)
    const project = await d.loadProject(guard.root)
    stage = 'planner'
    const item = selectItem(await d.readPlanner(project.root), options.selector, options.packageName)
    stage = 'evidence'
    const evidence = await d.readEvidence(project, item)
    stage = 'configuration'
    const context = await d.loadNpmContext(project.root)
    context.projectRoot = project.root
    staging = await d.createStagingProject(project, context)
    stage = 'resolution'
    const transaction = await d.executeActions(project, item, evidence, context, { ...d, staging })
    const installContext = current => ({ ...current, installArgs: ['ci', ...current.installArgs.slice(1)] })
    const verifySnapshot = async (snapshot, root, currentContext) => {
      await d.installProject(root, installContext(currentContext), { stderr: io.stderr })
      const files = await readDependencyFiles(root)
      for (const name of Object.keys(files)) if (!files[name].equals(snapshot.files[name])) throw new Error('npm changed verified dependency files')
      await d.verifyFinalSecurity(evidence, snapshot.candidate, snapshot, { ...currentContext, projectRoot: root })
      const installed = await d.loadGraph(root, { actual: true })
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
    const commits = await d.commitSnapshots(guard, transaction.snapshots, transaction.actions, context, options, { commitUpgrade: d.commitUpgrade, prepareSnapshot: async (snapshot) => {
      guard.installedTreeMayHaveChanged = true
      await verifySnapshot(snapshot, project.root, context)
    } })
    const result = { schemaVersion: 3, id: item.id, package: item.package, oldVersion: item.version, targetLocation: item.targetLocation, resolution: transaction.coverage.resolution, actions: transaction.actions, commits }
    io.stdout.write(options.format === 'json' ? renderJson(result) : renderMarkdown(result))
    return 0
  }
  catch (error) {
    let recovery = ''
    if (mutated && (!committing || (error.committed && error.committed.length === 0))) {
      try {
        const result = await restoreDependencyFiles(guard)
        recovery = ` Dependency files restored.${result.installedTreeMayHaveChanged ? ' node_modules may have changed.' : ''}`
      }
      catch (e) { recovery = ` Recovery could not restore dependency files: ${e.message}. node_modules may have changed.` }
    }
    else if (committing) recovery = ' Verified dependency changes may remain uncommitted; inspect Git state.'
    else if (staging) recovery = ' Original dependency files were not changed by this operation.'
    io.stderr.write(`npm-dep-upgrade: ${error.stage || stage}: ${error.message}${recovery}\n`)
    return 1
  }
  finally {
    if (staging) await staging.cleanup().catch(() => io.stderr.write('npm-dep-upgrade: could not remove private staging directory\n'))
  }
}
