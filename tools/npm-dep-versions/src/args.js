import path from 'node:path'
import semver from 'semver'
import { packageNamePattern } from './model.js'

export function parseArgs(argv, cwd = process.cwd()) {
  const options = { packageName: null, projectPath: cwd, all: false, major: null, range: null, format: 'markdown', ttlMs: 3600000, noCache: false, clearCache: false, debug: false, help: argv.includes('--help'), version: argv.includes('--version') }
  if (options.help || options.version) return options
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const switches = { '--all': 'all', '--no-cache': 'noCache', '--clear-cache': 'clearCache', '--debug': 'debug' }
    if (Object.hasOwn(switches, arg)) {
      options[switches[arg]] = true
      continue
    }
    if (['--major', '--range', '--format', '--project', '--cache-ttl'].includes(arg)) {
      if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`)
      seen.add(arg)
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      if (arg === '--major') {
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid major version')
        options.major = Number(value)
      }
      if (arg === '--range') {
        if (!value.trim() || semver.validRange(value) === null) throw new Error('Invalid semantic version range')
        options.range = value
      }
      if (arg === '--format') {
        if (!['markdown', 'json'].includes(value)) throw new Error('Invalid format; use markdown or json')
        options.format = value
      }
      if (arg === '--project') options.projectPath = path.resolve(cwd, value)
      if (arg === '--cache-ttl') {
        const match = /^(\d+)([smhd])$/.exec(value)
        const duration = match && Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]])
        if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Invalid cache TTL; use a positive duration such as 30m or 1h')
        options.ttlMs = duration
      }
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    if (options.packageName !== null) throw new Error('Only one package name is allowed')
    options.packageName = arg
  }
  if (!options.packageName && options.clearCache) return { ...options, clearOnly: true }
  if (!options.packageName || !packageNamePattern.test(options.packageName)) throw new Error('A valid package name is required; version specs are not supported')
  return options
}
