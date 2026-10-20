import { fail } from './errors.js'
import path from 'node:path'
export function parseArgs(argv, cwd = process.cwd()) {
  const result = { projectPath: path.resolve(cwd), selector: null, packageName: null, format: 'markdown', action: 'upgrade', provided: [] }
  if (argv.includes('--help')) return { ...result, action: 'help' }
  if (argv.includes('--version')) return { ...result, action: 'version' }
  const seen = new Set(), positional = []
  const values = { '--package': 'packageName', '--format': 'format', '--config': 'configPath', '--module': 'module', '--commit-message-template': 'commitMessageTemplate' }
  const assign = (key, value) => {
    result[key] = value
    result.provided.push(key)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--debug' || arg === '--no-debug') {
      if (seen.has('debug')) fail('INVALID_ARGUMENT', 'arguments', 'Repeated debug option')
      seen.add('debug')
      assign('debug', arg === '--debug')
    }
    else if (arg === '--clear-git-commit-args') {
      if (seen.has('gitCommitArgs') || result.gitCommitArgs) fail('INVALID_ARGUMENT', 'arguments', 'Cannot combine clear and commit arguments')
      seen.add('gitCommitArgs')
      assign('gitCommitArgs', [])
    }
    else if (arg === '--git-commit-arg' || arg.startsWith('--git-commit-arg=')) {
      if (seen.has('gitCommitArgs')) fail('INVALID_ARGUMENT', 'arguments', 'Cannot combine clear and commit arguments')
      const value = arg === '--git-commit-arg' ? argv[++i] : arg.slice('--git-commit-arg='.length)
      if (!value) fail('INVALID_ARGUMENT', 'arguments', 'Missing --git-commit-arg value')
      if (!result.gitCommitArgs) assign('gitCommitArgs', [])
      result.gitCommitArgs.push(value)
    }
    else if (Object.hasOwn(values, arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('-') || seen.has(arg)) fail('INVALID_ARGUMENT', 'arguments', `Missing or repeated ${arg}`)
      seen.add(arg)
      const key = values[arg]
      if (key === 'packageName' && !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(value)) fail('INVALID_ARGUMENT', 'arguments', 'Invalid package name')
      if (key === 'format' && !['markdown', 'json'].includes(value)) fail('INVALID_ARGUMENT', 'arguments', 'Format must be markdown or json')
      assign(key, key === 'configPath' ? path.resolve(cwd, value) : value)
    }
    else if (arg.startsWith('-')) fail('INVALID_ARGUMENT', 'arguments', `Unknown option: ${arg}`)
    else positional.push(arg)
  }
  if (positional.length < 1 || positional.length > 2) fail('INVALID_ARGUMENT', 'arguments', 'Expected an item ID and optional project directory')
  result.selector = positional.at(-1)
  if (!/^[a-f0-9]{7,64}$/.test(result.selector)) fail('INVALID_ARGUMENT', 'arguments', 'Expected exactly one lowercase hexadecimal item ID (7–64 characters)')
  if (positional.length === 2) assign('projectPath', path.resolve(cwd, positional[0]))
  return result
}
