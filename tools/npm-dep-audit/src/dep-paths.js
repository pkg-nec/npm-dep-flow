import { spawn } from 'node:child_process'

const packageNamePattern = /^(?:[a-z0-9][a-z0-9._~-]*|@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*)$/i

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateEnvelope(report, packageName) {
  if (!isRecord(report) || report.schemaVersion !== 2
    || !isRecord(report.project) || typeof report.project.name !== 'string'
    || typeof report.project.version !== 'string' || report.selector !== packageName
    || !Array.isArray(report.results)) {
    throw new Error('Invalid npm-dep-paths response: missing schema version 2 name-query fields')
  }

  for (const result of report.results) {
    if (!isRecord(result) || result.package !== packageName
      || typeof result.version !== 'string' || !result.version || !Array.isArray(result.requirements)) {
      throw new Error(`Invalid npm-dep-paths response for ${packageName}: malformed package result`)
    }
    for (const requirement of result.requirements) {
      if (!isRecord(requirement) || typeof requirement.declaredRequirement !== 'string'
        || !Array.isArray(requirement.directDependents)) {
        throw new Error(`Invalid npm-dep-paths response for ${packageName}@${result.version}: malformed requirement`)
      }
      for (const dependent of requirement.directDependents) {
        if (!isRecord(dependent)
          || ['name', 'version', 'location', 'targetLocation', 'type', 'requestedName']
            .some(field => typeof dependent[field] !== 'string')) {
          throw new Error(`Invalid npm-dep-paths response for ${packageName}@${result.version}: malformed direct dependent`)
        }
      }
    }
  }
  return report
}

function command(projectRoot, packageName, spawnImpl, platform, noCache) {
  return new Promise((resolve, reject) => {
    const windows = platform === 'win32'
    const args = ['.', packageName, '--format', 'json', ...(noCache ? ['--no-cache'] : [])]
    let child
    try {
      child = spawnImpl(
        windows ? `npm-dep-paths.cmd ${args.join(' ')}` : 'npm-dep-paths',
        windows ? [] : args,
        { cwd: projectRoot, shell: windows, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    }
    catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const fail = (error) => {
      if (done) return
      done = true
      child.kill?.()
      reject(error)
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      const message = error.code === 'ENOENT'
        ? 'npm-dep-paths is not available on PATH; install it as a standalone CLI'
        : `Cannot start npm-dep-paths: ${error.message}`
      fail(new Error(message, { cause: error }))
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      if (code !== 0) {
        reject(new Error(`npm-dep-paths ${packageName} failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`))
        return
      }
      let report
      try {
        report = JSON.parse(stdout)
      }
      catch (error) {
        reject(new Error(`Invalid npm-dep-paths JSON for ${packageName}: ${error.message}`, { cause: error }))
        return
      }
      try {
        resolve(validateEnvelope(report, packageName))
      }
      catch (error) {
        reject(error)
      }
    })
  })
}

export function runNpmDepPaths(projectRoot, packageName, spawnImpl = spawn, platform = process.platform, { noCache = false } = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) return Promise.reject(new Error('A project directory is required for npm-dep-paths'))
  if (typeof packageName !== 'string' || !packageNamePattern.test(packageName)) {
    return Promise.reject(new Error(`Invalid package name for npm-dep-paths: ${packageName}`))
  }
  return command(projectRoot, packageName, spawnImpl, platform, noCache)
}
