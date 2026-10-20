import { fail } from './errors.js'
import path from 'node:path'
export function parseArgs(argv, cwd = process.cwd()) {
  const result = { projectPath: path.resolve(cwd), selector: null, packageName: null, format: 'markdown', action: 'upgrade' }
  if (argv.includes('--help')) return { ...result, action: 'help' }
  if (argv.includes('--version')) return { ...result, action: 'version' }
  const seen = new Set()
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package' || arg === '--format') {
      const value = argv[++i]
      if (!value || value.startsWith('-') || seen.has(arg)) fail('INVALID_ARGUMENT', 'arguments', `Missing or repeated ${arg}`)
      seen.add(arg)
      if (arg === '--package') {
        if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(value)) fail('INVALID_ARGUMENT', 'arguments', 'Invalid package name')
        result.packageName = value
      }
      else {
        if (!['markdown', 'json'].includes(value)) fail('INVALID_ARGUMENT', 'arguments', 'Format must be markdown or json')
        result.format = value
      }
    }
    else if (arg.startsWith('-')) {
      fail('INVALID_ARGUMENT', 'arguments', `Unknown option: ${arg}`)
    }
    else positional.push(arg)
  }
  if (positional.length < 1 || positional.length > 2) fail('INVALID_ARGUMENT', 'arguments', 'Expected an item ID and optional project directory')
  result.selector = positional.at(-1)
  if (!/^[a-f0-9]{7,64}$/.test(result.selector)) fail('INVALID_ARGUMENT', 'arguments', 'Expected exactly one lowercase hexadecimal item ID (7–64 characters)')
  if (positional.length === 2) result.projectPath = path.resolve(cwd, positional[0])
  return result
}
