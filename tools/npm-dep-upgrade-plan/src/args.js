import path from 'node:path'

export function parseArgs(argv, cwd = process.cwd()) {
  if (argv.includes('--help')) {
    return { projectPath: cwd, format: 'markdown', help: true }
  }

  let projectPath = cwd
  let hasProjectPath = false
  let format = 'markdown'

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
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

  return { projectPath, format, help: false }
}
