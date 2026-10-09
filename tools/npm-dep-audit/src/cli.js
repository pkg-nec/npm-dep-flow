import { loadProject } from './project.js'
import { readNpmContext } from './npm-audit.js'
import { getAudit } from './cache.js'
import { buildRows, selectRows } from './rows.js'
import { renderMarkdown, renderJson } from './render.js'

const defaults = { loadProject, readNpmContext, getAudit }
const severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 }

const help = `Usage: npm-dep-audit [project] [options]

Options:
  --format markdown|json           Output format (default: markdown)
  --min-severity info|low|moderate|high|critical
                                   Minimum row severity (default: info)
  --cache-ttl <duration>           Cache lifetime, e.g. 30m or 1h (default: 1h)
  --no-cache                       Run a fresh audit without cache access
  --help                           Show this help
`

function parse(argv) {
  const options = { path: process.cwd(), format: 'markdown', minSeverity: 'info', ttlMs: 3600000, noCache: false }
  let hasPath = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-cache') { options.noCache = true; continue }
    if (arg === '--format' || arg === '--min-severity' || arg === '--cache-ttl') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      if (arg === '--format') {
        if (!['markdown', 'json'].includes(value)) throw new Error(`Invalid format: ${value}`)
        options.format = value
      } else if (arg === '--min-severity') {
        if (!severities.has(value)) throw new Error(`Invalid minimum severity: ${value}`)
        options.minSeverity = value
      } else {
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
  try {
    const options = parse(argv)
    const project = await deps.loadProject(options.path)
    const context = await deps.readNpmContext(project.root)
    const { audit, auditedAt } = await deps.getAudit(project, context, { ttlMs: options.ttlMs, noCache: options.noCache })
    const rows = selectRows(buildRows(project.lock, audit), options.minSeverity)
    io.stdout.write(options.format === 'json' ? renderJson(rows, auditedAt) : renderMarkdown(rows))
    return 0
  } catch (error) {
    io.stderr.write(`npm-dep-audit: ${error.message}\n`)
    return 1
  }
}
