import { parseArgs } from './args.js'
import { runNpmDepAudit } from './audit.js'
import { evaluateFindings } from './evaluate.js'
import { fetchStableVersions } from './registry.js'
import { renderJson, renderMarkdown } from './report.js'

const defaults = { runNpmDepAudit, fetchStableVersions, renderJson, renderMarkdown }

const help = `Usage: npm-dep-upgrade-plan [project] [options]

Options:
  --format markdown|json  Output format (default: markdown)
  --help                  Show this help
`

export async function main(argv, io = process, deps = defaults) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      io.stdout.write(help)
      return 0
    }

    const auditReport = await deps.runNpmDepAudit(options.projectPath)
    const versionsByPackage = new Map()
    const packageNames = [...new Set(auditReport.rows.map(row => row.package))]
    for (const packageName of packageNames) {
      versionsByPackage.set(
        packageName,
        await deps.fetchStableVersions(options.projectPath, packageName),
      )
    }

    const findings = evaluateFindings(auditReport.rows, versionsByPackage)
    const output = options.format === 'json'
      ? deps.renderJson(findings, auditReport.auditedAt)
      : deps.renderMarkdown(findings)
    io.stdout.write(output)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    io.stderr.write(`npm-dep-upgrade-plan: ${message}\n`)
    return 1
  }
}
