import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProject } from './project.js'
import { buildGraph } from './graph.js'
import { parseSelector } from './selector.js'
import { collectSummaryResults } from './summary.js'
import { collectUpstream } from './upstream.js'
import { renderSummaryText, renderSummaryJson, renderUpstreamText } from './report.js'

const defaults = { loadProject, buildGraph, parseSelector, collectSummaryResults, collectUpstream, renderSummaryText, renderSummaryJson, renderUpstreamText }
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const versionOutput = `${packageJson.name} v${packageJson.version}\nLocation: ${packageDir}\n`
const help = `${packageJson.name} v${packageJson.version}

Usage: npm-dep-paths [project] <package-selector> [--format markdown|json] [--upstream-of <package@exact-version> [--from <package@exact-version>]]

Arguments:
  project                          Project directory (default: ., the caller's current directory)
  package-selector                 Required package name or exact version selector

Selectors:
  package-name                     Summarize all reachable installed versions
  package-name@exact-version       Summarize one exact installed version

Options:
  --format markdown|json               Output format (default: markdown; text is an alias)
  --upstream-of package@version    Explain a direct dependent of an exact target version
  --from package@version           Focus upstream detail on one top-level package
  --version                        Show version and tool directory
  --help                           Show this help
`

function parseArgs(argv) {
  const positional = []
  let format = 'markdown'
  let upstreamOf
  let from
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--format') {
      const value = argv[++i]
      if (!['markdown', 'text', 'json'].includes(value)) throw new Error(`Invalid format: ${value ?? '(missing)'}`)
      format = value
    } else if (arg === '--upstream-of') {
      upstreamOf = argv[++i]
      if (!upstreamOf || upstreamOf.startsWith('-')) throw new Error('Missing --upstream-of package selector')
    } else if (arg === '--from') {
      from = argv[++i]
      if (!from || from.startsWith('-')) throw new Error('Missing --from package selector')
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length < 1 || positional.length > 2) throw new Error('Expected a package selector and optional project directory')
  const [path, selectorText] = positional.length === 1 ? [process.cwd(), positional[0]] : positional
  return { path, selectorText, format, upstreamOf, from }
}

function fencedText(text) {
  const content = text.trimEnd()
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}text\n${content}\n${fence}`
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
    const options = parseArgs(argv)
    const selector = deps.parseSelector(options.selectorText)
    if (options.from && !options.upstreamOf) throw new Error('--from requires --upstream-of')
    if (options.upstreamOf && selector.kind !== 'exact') throw new Error('--upstream-of requires an exact target version')
    const dependent = options.upstreamOf ? deps.parseSelector(options.upstreamOf) : undefined
    const from = options.from ? deps.parseSelector(options.from) : undefined
    if (dependent && dependent.kind !== 'exact') throw new Error('--upstream-of requires an exact dependent version')
    if (from && from.kind !== 'exact') throw new Error('--from requires an exact top-level package version')
    const project = await deps.loadProject(options.path)
    const graph = deps.buildGraph(project)
    const results = deps.collectSummaryResults(graph, selector)
    const upstream = dependent ? deps.collectUpstream(graph, results[0], dependent, from) : undefined
    const report = options.format === 'json'
      ? deps.renderSummaryJson(project, selector, results, upstream)
      : `${deps.renderSummaryText(project, results).trimEnd()}${upstream ? `\n\n${fencedText(deps.renderUpstreamText(project, results[0], upstream, from))}` : ''}\n`
    io.stdout.write(report)
    return 0
  } catch (error) {
    io.stderr.write(`npm-dep-paths: ${error.message}\n`)
    return 1
  }
}
