import { spawn } from 'node:child_process'
import semver from 'semver'
import { runProcess } from './process.js'

const severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const dependentFields = ['name', 'version', 'location', 'targetLocation', 'type', 'requestedName']

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message) {
  throw new Error(`Invalid npm-dep-audit JSON: ${message}`)
}

function validateAuditReport(report) {
  if (!isRecord(report) || report.schemaVersion !== 2) {
    invalid('expected schema version 2')
  }
  if (typeof report.auditedAt !== 'string' || !Number.isFinite(Date.parse(report.auditedAt))) {
    invalid('auditedAt must be a valid timestamp')
  }
  if (!Array.isArray(report.rows)) invalid('rows must be an array')

  const rows = report.rows.map((row, rowIndex) => {
    if (!isRecord(row) || typeof row.package !== 'string' || !row.package
      || typeof row.version !== 'string' || !semver.valid(row.version)
      || !severities.has(row.severity) || !Array.isArray(row.advisories) || row.advisories.length === 0
      || !Array.isArray(row.requirements)) {
      invalid(`row ${rowIndex} is malformed`)
    }
    if (row.requirements.length === 0) invalid(`row ${rowIndex} must contain requirement groups`)

    const advisories = row.advisories.map((advisory, advisoryIndex) => {
      if (!isRecord(advisory)
        || (!(typeof advisory.id === 'string' && advisory.id.length > 0)
          && !(typeof advisory.id === 'number' && Number.isFinite(advisory.id)))
        || typeof advisory.title !== 'string' || typeof advisory.url !== 'string'
        || !severities.has(advisory.severity) || typeof advisory.range !== 'string'
        || semver.validRange(advisory.range) === null) {
        invalid(`row ${rowIndex} advisory ${advisoryIndex} is malformed or has an invalid advisory range`)
      }
      return {
        id: advisory.id,
        title: advisory.title,
        url: advisory.url,
        severity: advisory.severity,
        range: advisory.range,
      }
    })

    const requirements = row.requirements.map((requirement, requirementIndex) => {
      if (!isRecord(requirement) || typeof requirement.declaredRequirement !== 'string'
        || !Array.isArray(requirement.directDependents) || requirement.directDependents.length === 0) {
        invalid(`row ${rowIndex} requirement ${requirementIndex} is malformed or has no direct dependents`)
      }
      const directDependents = requirement.directDependents.map((dependent, dependentIndex) => {
        if (!isRecord(dependent) || dependentFields.some(field => typeof dependent[field] !== 'string')) {
          invalid(`row ${rowIndex} requirement ${requirementIndex} direct dependent ${dependentIndex} is malformed`)
        }
        return Object.fromEntries(dependentFields.map(field => [field, dependent[field]]))
      })
      return { declaredRequirement: requirement.declaredRequirement, directDependents }
    })

    return {
      package: row.package,
      version: row.version,
      severity: row.severity,
      advisories,
      requirements,
    }
  })

  return { schemaVersion: 2, auditedAt: report.auditedAt, rows }
}

export async function runNpmDepAudit(projectRoot, spawnImpl = spawn, platform = process.platform, { noCache = false, ttlMs = 3600000, clearCache = false } = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw new Error('A project directory is required for npm-dep-audit')
  }

  let result
  try {
    result = await runProcess(
      'npm-dep-audit',
      ['.', '--min-severity', 'info', '--format', 'json', ...(ttlMs !== 3600000 ? ['--cache-ttl', `${ttlMs / 1000}s`] : []), ...(noCache ? ['--no-cache'] : []), ...(clearCache ? ['--clear-cache'] : [])],
      projectRoot,
      spawnImpl,
      platform,
    )
  }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('npm-dep-audit is not available on PATH; install it as a standalone CLI', { cause: error })
    }
    throw new Error('Cannot start npm-dep-audit', { cause: error })
  }

  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim()
        ? `npm-dep-audit failed with exit code ${result.code}: ${result.stderr.trim()}`
        : `npm-dep-audit failed with exit code ${result.code}; check that this is a supported npm project and npm-dep-paths is installed and available on PATH`,
    )
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  }
  catch {
    throw new Error('npm-dep-audit returned invalid JSON')
  }
  return validateAuditReport(report)
}

// Clear-only request: audit deletes its cache (and its own sibling caches) without analyzing anything.
export async function clearNpmDepAuditCache(cwd = process.cwd(), spawnImpl = spawn, platform = process.platform) {
  let result
  try {
    result = await runProcess('npm-dep-audit', ['--clear-cache'], cwd, spawnImpl, platform)
  }
  catch (error) {
    throw new Error(error?.code === 'ENOENT' ? 'npm-dep-audit is not available on PATH; install it as a standalone CLI' : 'Cannot start npm-dep-audit', { cause: error })
  }
  if (result.code !== 0) throw new Error(`npm-dep-audit --clear-cache failed with exit code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
}
