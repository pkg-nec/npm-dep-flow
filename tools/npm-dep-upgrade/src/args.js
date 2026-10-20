import { fail } from './errors.js'
export function parseArgs(argv) {
  const result = { selector: null, packageName: null, format: 'markdown', action: 'upgrade' }
  if (argv.includes('--help')) return { ...result, action: 'help' }
  if (argv.includes('--version')) return { ...result, action: 'version' }
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package' || arg === '--format') {
      const value = argv[++i]
      if (!value || value.startsWith('-') || seen.has(arg)) fail('INVALID_ARGUMENT', 'arguments', `Missing or repeated ${arg}`)
      seen.add(arg)
      if (arg === '--package') {
        if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(value)) fail('INVALID_ARGUMENT', 'arguments', 'Invalid package name')
        result.packageName = value
      } else {
        if (!['markdown', 'json'].includes(value)) fail('INVALID_ARGUMENT', 'arguments', 'Format must be markdown or json')
        result.format = value
      }
    } else if (arg.startsWith('-') || result.selector !== null || !/^[a-f0-9]{7,64}$/.test(arg)) {
      fail('INVALID_ARGUMENT', 'arguments', 'Expected exactly one lowercase hexadecimal item ID (7–64 characters)')
    } else result.selector = arg
  }
  if (!result.selector) fail('INVALID_ARGUMENT', 'arguments', 'An item ID is required')
  return result
}
