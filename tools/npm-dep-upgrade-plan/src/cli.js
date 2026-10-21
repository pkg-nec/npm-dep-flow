import { runDebug } from './debug.js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cachedResult } from './result-cache.js'
import { loadProject } from './project.js'
import { readPlanningContext } from './context.js'
import { parseArgs } from './args.js'
import { runNpmDepAudit } from './audit.js'
import { evaluateFindings } from './evaluate.js'
import { runNpmDepVersions } from './versions.js'
import { renderJson, renderMarkdown } from './report.js'

const defaults = { loadProject, readPlanningContext, runNpmDepAudit, runNpmDepVersions, renderJson, renderMarkdown }
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
    const project = await deps.loadProject(options.projectPath)
    const identity = options.noCache ? null : await deps.readPlanningContext(project.root)
    const report = await cachedResult({
      tool: packageJson.name, version: packageJson.version, project, identity,
      ttlMs: options.ttlMs, noCache: options.noCache,
    }, async () => {
      const auditReport = await deps.runNpmDepAudit(project.root, undefined, undefined, { noCache: options.noCache, ttlMs: options.ttlMs })
      const versionsByPackage = new Map()
      const packageNames = [...new Set(auditReport.rows.map(row => row.package))]
      let freshAt = Date.parse(auditReport.auditedAt)
      for (const packageName of packageNames) {
        const catalog = await deps.runNpmDepVersions(project.root, packageName, undefined, undefined, { noCache: options.noCache, ttlMs: options.ttlMs })
        versionsByPackage.set(packageName, { versions: catalog.versions, releaseTimes: catalog.releaseTimes })
        freshAt = Math.min(freshAt, Date.parse(catalog.fetchedAt))
      }
      return {
        value: { findings: evaluateFindings(auditReport.rows, versionsByPackage), auditedAt: auditReport.auditedAt },
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
