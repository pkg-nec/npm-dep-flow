import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './args.js'
import { runNpmDepAudit } from './audit.js'
import { evaluateFindings } from './evaluate.js'
import { fetchReleaseTimes, fetchStableVersions } from './registry.js'
import { renderJson, renderMarkdown } from './report.js'

const defaults = { runNpmDepAudit, fetchStableVersions, fetchReleaseTimes, renderJson, renderMarkdown }
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const versionOutput = `${packageJson.name} v${packageJson.version}\nLocation: ${packageDir}\n`

const help = `${packageJson.name} v${packageJson.version}

Usage: npm-dep-upgrade-plan [project] [options]

Options:
  --format markdown|json  Output format (default: markdown)
  --version               Show version and tool directory
  --help                  Show this help
`

export async function main(argv, io = process, deps = defaults) {
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
    const auditReport = await deps.runNpmDepAudit(options.projectPath)
    const versionsByPackage = new Map()
    const packageNames = [...new Set(auditReport.rows.map(row => row.package))]
    for (const packageName of packageNames) {
      const [versions, releaseTimes] = await Promise.all([
        deps.fetchStableVersions(options.projectPath, packageName),
        deps.fetchReleaseTimes
          ? deps.fetchReleaseTimes(options.projectPath, packageName)
          : Promise.resolve(new Map()),
      ])
      versionsByPackage.set(packageName, { versions, releaseTimes })
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
