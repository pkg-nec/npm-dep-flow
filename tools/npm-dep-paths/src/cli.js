import { loadProject } from './project.js'
import { buildGraph } from './graph.js'
import { parseSelector, collectResults } from './routes.js'
import { renderText, renderJson } from './render.js'

const defaults = { loadProject, buildGraph, parseSelector, collectResults, renderText, renderJson }
const help = `Usage: npm-dep-paths <project> <package-selector> [--format text|json]

Selectors:
  package-name                     Show all reachable installed versions
  package-name@exact-version       Show one exact installed version

Options:
  --format text|json               Output format (default: text)
  --help                           Show this help
`

function parseArgs(argv) {
  const positional = []
  let format = 'text'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--format') {
      const value = argv[++i]
      if (!['text', 'json'].includes(value)) throw new Error(`Invalid format: ${value ?? '(missing)'}`)
      format = value
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 2) throw new Error('Expected a project directory and package selector')
  return { path: positional[0], selectorText: positional[1], format }
}

export async function main(argv, io = process, deps = defaults) {
  if (argv.includes('--help')) {
    io.stdout.write(help)
    return 0
  }
  try {
    const options = parseArgs(argv)
    const selector = deps.parseSelector(options.selectorText)
    const project = await deps.loadProject(options.path)
    const graph = deps.buildGraph(project)
    const results = deps.collectResults(graph, selector)
    const report = options.format === 'json' ? deps.renderJson(project, selector, results) : deps.renderText(project, results)
    io.stdout.write(report)
    return 0
  } catch (error) {
    io.stderr.write(`npm-dep-paths: ${error.message}\n`)
    return 1
  }
}
