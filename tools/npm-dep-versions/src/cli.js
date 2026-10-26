import { readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './args.js'
import { fetchCatalog } from './registry.js'
import { filterRows } from './filter.js'
import { renderJson, renderMarkdown } from './report.js'
import { cachedCatalog } from './cache.js'
import { clearCache } from './cache-clear.js'
import { readContext } from './context.js'
import { runDebug } from './debug.js'

const packageDir = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '')
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const versionOutput = `${metadata.name} v${metadata.version}\nLocation: ${packageDir}\n`
const help = `${metadata.name} v${metadata.version}

Usage: npm-dep-versions <package> [options]

Arguments:
  package                       Exact package name, including @scope/name

Options:
  --all                         Include prereleases
  --major <number>              Restrict to one major version
  --range <range>               Restrict to a semantic version range
  --project <directory>         npm configuration context (default: caller's cwd)
  --format markdown|json        Output format (default: markdown)
  --cache-ttl <duration>        Cache lifetime, e.g. 30m or 1h (default: 1h)
  --no-cache                    Bypass cache reads and writes
  --clear-cache                 Delete this tool's cache; with no package, only clear
  --debug                       Log external actions and cache decisions to stderr
  --version                     Show version and tool directory
  --help                        Show this help
`

export async function main(argv, io = process, deps = {}) {
  return runDebug(argv.includes('--debug'), io, async () => {
    try {
      const options = parseArgs(argv)
      if (options.help || options.version) {
        io.stdout.write(options.help ? help : versionOutput)
        return 0
      }
      if (options.clearCache) await (deps.clearCache || clearCache)({ tool: metadata.name, cacheRoot: deps.cacheRoot })
      if (options.clearOnly) return 0
      let root
      try {
        root = await realpath(options.projectPath)
        if (!(await stat(root)).isDirectory()) throw new Error('Not a directory')
      }
      catch { throw new Error('The npm context must be an existing directory') }
      const identity = options.noCache ? null : await (deps.readContext || readContext)(root)
      const catalog = await cachedCatalog({ version: metadata.version, root, packageName: options.packageName, identity, ttlMs: options.ttlMs, noCache: options.noCache, cacheRoot: deps.cacheRoot }, () => (deps.fetchCatalog || fetchCatalog)(root, options.packageName))
      const report = { ...catalog, rows: filterRows(catalog.rows, options) }
      io.stdout.write(options.format === 'json' ? renderJson(report) : renderMarkdown(report))
      return 0
    }
    catch (error) {
      io.stderr.write(`npm-dep-versions: ${error.message}\n`)
      return 1
    }
  })
}
