import path from 'node:path'

export function parseArgs(argv, cwd = process.cwd()) {
  if (argv.includes('--help')) {
    return { projectPath: cwd, format: 'markdown', help: true }
  }

  let projectPath = cwd
  let hasProjectPath = false
  let format = 'markdown'
  let noCache = false
  let ttlMs = 3600000

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--no-cache') {
      noCache = true
      continue
    }
    if (argument === '--cache-ttl') {
      const value = argv[++index]
      const match = /^(\d+)([smhd])$/.exec(value || '')
      const duration = match && Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]])
      if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Invalid cache TTL; use a positive duration such as 30m or 1h')
      ttlMs = duration
      continue
    }
    if (argument === '--format') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --format')
      }
      if (value !== 'markdown' && value !== 'json') {
        throw new Error(`Invalid format: ${value}`)
      }
      format = value
      index += 1
      continue
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`)
    }
    if (hasProjectPath) {
      throw new Error('Only one project path is allowed')
    }

    projectPath = path.resolve(cwd, argument)
    hasProjectPath = true
  }

  return { projectPath, format, help: false, noCache, ttlMs }
}
