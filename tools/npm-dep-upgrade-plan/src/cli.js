import { runDebug } from './debug.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cachedResult } from './result-cache.js'
import { clearCache } from './cache-clear.js'
import { loadProject } from './project.js'
import { readPlanningContext } from './context.js'
import { parseArgs } from './args.js'
import { clearNpmDepAuditCache, runNpmDepAudit } from './audit.js'
import { withRootDeclarations } from './coverage.js'
import { resolveChoices } from './resolver.js'
import { evaluateFindings } from './evaluate.js'
import { clearNpmDepVersionsCache, runNpmDepVersions } from './versions.js'
import { renderJson, renderMarkdown } from './report.js'
import { readUpstream } from './paths.js'
import { readReleasePolicy } from './policy.js'
import { findParentChoices } from './ancestors.js'
import { planParentChoices } from './parent-planning.js'
import { ANGULAR_LINES } from './angular-lines.js'
import { planLineChoices } from './angular-line-planning.js'

const defaults = { loadProject, readPlanningContext, runNpmDepAudit, runNpmDepVersions, resolveChoices, renderJson, renderMarkdown }
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const versionOutput = `${packageJson.name} v${packageJson.version}\nLocation: ${packageDir}\n`

const help = `${packageJson.name} v${packageJson.version}

Usage: npm-dep-upgrade-plan [project] [options]

Arguments:
  project                       Project directory (default: ., the caller's current directory)

Options:
  --format markdown|json        Output format (default: markdown)
  --cache-ttl <duration>        Cache lifetime, e.g. 30m or 1h (default: 1h)
  --no-cache                    Bypass caches, including audit, paths, and versions
  --clear-cache                 Delete this tool's and its sibling tools' caches; with no project, only clear
  --debug                       Log external actions and cache decisions to stderr
  --version                     Show version and tool directory
  --help                        Show this help
`

export async function main(argv, io = process, deps = defaults) {
  return runDebug(argv.includes('--debug'), io, () => mainWithDebug(argv, io, deps))
}

async function mainWithDebug(argv, io = process, deps = defaults) {
  if (argv.includes('--help')) {
    io.stdout.write(help)
    return 0
  }
  if (argv.includes('--version')) {
    io.stdout.write(versionOutput)
    return 0
  }

  try {
    const options = parseArgs(argv)
    if (options.clearCache) await (deps.clearCache ?? clearCache)({ tool: packageJson.name })
    if (options.clearOnly) {
      await (deps.clearNpmDepAuditCache ?? clearNpmDepAuditCache)(process.cwd())
      await (deps.clearNpmDepVersionsCache ?? clearNpmDepVersionsCache)(process.cwd())
      return 0
    }
    const clearControl = options.clearCache ? { clearCache: true } : {}
    const project = await deps.loadProject(options.projectPath)
    const identity = options.noCache ? null : await deps.readPlanningContext(project.root)
    const report = await cachedResult({
      tool: packageJson.name, version: packageJson.version, project, identity,
      ttlMs: options.ttlMs, noCache: options.noCache,
    }, async () => {
      const auditReport = await deps.runNpmDepAudit(project.root, undefined, undefined, { noCache: options.noCache, ttlMs: options.ttlMs, ...clearControl })
      auditReport.rows = withRootDeclarations(auditReport.rows, JSON.parse(project.manifestBytes?.toString() || '{}'))
      const versionsByPackage = new Map()
      const catalogs = new Map()
      const readCatalog = (name) => {
        if (!catalogs.has(name)) catalogs.set(name, deps.runNpmDepVersions(project.root, name, undefined, undefined, { noCache: options.noCache, ttlMs: options.ttlMs, ...clearControl }))
        return catalogs.get(name)
      }
      const packageNames = [...new Set(auditReport.rows.map(row => row.package))]
      let freshAt = Date.parse(auditReport.auditedAt)
      for (const packageName of packageNames) {
        const catalog = await readCatalog(packageName)
        versionsByPackage.set(packageName, { versions: catalog.versions, releaseTimes: catalog.releaseTimes })
        freshAt = Math.min(freshAt, Date.parse(catalog.fetchedAt))
      }
      const findings = evaluateFindings(auditReport.rows, versionsByPackage)
      for (const finding of findings) {
        if (finding.resolution !== 'partial' && finding.choices.length <= 1) continue
        const auditRow = auditReport.rows.find(row => row.package === finding.package && row.version === finding.version)
        const verified = await deps.resolveChoices(project, { ...auditRow, targetLocation: finding.targetLocation }, finding.choices, options)
        finding.choices = verified.choices
        finding.resolution = verified.coverage.resolution
        freshAt = Math.min(freshAt, verified.freshAt)
      }
      const adapters = { readCatalog, readUpstream: deps.readUpstream ?? readUpstream, findParentChoices: deps.findParentChoices ?? findParentChoices, resolveChoices: deps.resolveChoices, readReleasePolicy: deps.readReleasePolicy ?? readReleasePolicy }
      for (const finding of findings) {
        if (finding.resolution === 'complete') continue
        const row = auditReport.rows.find(candidate => candidate.package === finding.package && candidate.version === finding.version)
        const parents = await planParentChoices({ finding, row, project, options, controls: { noCache: options.noCache, ...clearControl }, adapters })
        freshAt = Math.min(freshAt, parents.freshAt)
      }
      // Each Angular line bump covers what within-range and parent actions left, and is resolved ahead of them.
      for (const line of ANGULAR_LINES) {
        for (const finding of findings) {
          if (finding.resolution === 'complete') continue
          const row = auditReport.rows.find(candidate => candidate.package === finding.package && candidate.version === finding.version)
          const planned = await planLineChoices({ line, finding, row, project, options, controls: { noCache: options.noCache, ...clearControl }, adapters })
          freshAt = Math.min(freshAt, planned.freshAt)
        }
      }
      // `none` means no action clears a branch, so it never carries choices (the executor rejects the mismatch).
      for (const finding of findings) if (finding.resolution === 'none') finding.choices = []
      return {
        value: { findings, auditedAt: auditReport.auditedAt },
        freshAt,
        expiresAt: freshAt + options.ttlMs,
      }
    })
    const output = options.format === 'json'
      ? deps.renderJson(report.findings, report.auditedAt)
      : deps.renderMarkdown(report.findings)
    io.stdout.write(output)
    return 0
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    io.stderr.write(`npm-dep-upgrade-plan: ${message}\n`)
    return 1
  }
}
