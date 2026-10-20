import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProject } from './project.js'
import { readNpmContext } from './npm-audit.js'
import { cachedResult } from './result-cache.js'
import { readPathsIdentity } from './identity.js'
import { getAudit } from './cache.js'
import { buildRows, selectRows } from './rows.js'
import { runNpmDepPaths } from './dep-paths.js'
import { attachRequirements } from './requirements.js'
import { renderMarkdown, renderJson } from './render.js'

const defaults = { loadProject, readNpmContext, getAudit, runNpmDepPaths }
const severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const versionOutput = `${packageJson.name} v${packageJson.version}\nLocation: ${packageDir}\n`

const help = `${packageJson.name} v${packageJson.version}

Usage: npm-dep-audit [project] [options]

Arguments:
  project                 Project directory (default: ., the caller's current directory)

Options:
  --format markdown|json           Output format (default: markdown)
  --min-severity info|low|moderate|high|critical
                                   Minimum row severity (default: info)
  --cache-ttl <duration>           Cache lifetime, e.g. 30m or 1h (default: 1h)
  --no-cache                       Run a fresh audit without cache access
  --version                        Show version and tool directory
  --help                           Show this help
`

function parse(argv) {
  const options = { path: process.cwd(), format: 'markdown', minSeverity: 'info', ttlMs: 3600000, noCache: false }
  let hasPath = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-cache') {
      options.noCache = true
      continue
    }
    if (arg === '--format' || arg === '--min-severity' || arg === '--cache-ttl') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      if (arg === '--format') {
        if (!['markdown', 'json'].includes(value)) throw new Error(`Invalid format: ${value}`)
        options.format = value
      }
      else if (arg === '--min-severity') {
        if (!severities.has(value)) throw new Error(`Invalid minimum severity: ${value}`)
        options.minSeverity = value
      }
      else {
        const match = /^(\d+)([smhd])$/.exec(value)
        if (!match || Number(match[1]) === 0 || !Number.isSafeInteger(Number(match[1]) * multipliers[match[2]])) {
          throw new Error(`Invalid cache TTL: ${value}; use a positive duration such as 30m or 1h`)
        }
        options.ttlMs = Number(match[1]) * multipliers[match[2]]
      }
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    if (hasPath) throw new Error('Only one project path is allowed')
    options.path = arg
    hasPath = true
  }
  return options
}

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
    const options = parse(argv)
    const project = await deps.loadProject(options.path)
    const context = await deps.readNpmContext(project.root)
    const { audit, auditedAt } = await deps.getAudit(project, context, { ttlMs: options.ttlMs, noCache: options.noCache })
    const rows = buildRows(project.lock, audit)
    const identity = options.noCache || !rows.length ? null : await (deps.readPathsIdentity ?? readPathsIdentity)(project.root)
    const enriched = await cachedResult({
      tool: packageJson.name, version: packageJson.version, project,
      identity: [context, identity, auditedAt, audit], noCache: options.noCache, ttlMs: options.ttlMs,
    }, async () => {
      const summariesByPackage = new Map()
      for (const packageName of new Set(rows.map(row => row.package))) {
        summariesByPackage.set(packageName, await deps.runNpmDepPaths(project.root, packageName, undefined, undefined, { noCache: options.noCache }))
      }
      return { value: attachRequirements(rows, summariesByPackage), expiresAt: Date.parse(auditedAt) + options.ttlMs }
    })
    const enrichedRows = selectRows(enriched, options.minSeverity)
    io.stdout.write(options.format === 'json' ? renderJson(enrichedRows, auditedAt) : renderMarkdown(enrichedRows))
    return 0
  }
  catch (error) {
    io.stderr.write(`npm-dep-audit: ${error.message}\n`)
    return 1
  }
}
