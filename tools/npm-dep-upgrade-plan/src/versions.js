import { spawn } from 'node:child_process'
import semver from 'semver'
import { runProcess } from './process.js'

const packageNamePattern = /^(?:[a-z0-9][a-z0-9._~-]*|@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*)$/i
const isoTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/

function isStrictStableVersion(value) {
  const parsed = semver.parse(value)
  if (!parsed || parsed.prerelease.length > 0) return false
  const buildMetadata = value.includes('+') ? value.slice(value.indexOf('+')) : ''
  return `${parsed.format()}${buildMetadata}` === value
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null
  const parts = isoTimestampPattern.exec(value)
  if (!parts) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = parts
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) {
    return null
  }

  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  return new Date(milliseconds).toISOString()
}

export async function runNpmDepVersions(projectRoot, packageName, spawnImpl = spawn, platform = process.platform, { noCache = false, ttlMs = 3600000, now = Date.now, clearCache = false } = {}) {
  if (typeof packageName !== 'string' || !packageNamePattern.test(packageName)) throw new Error('Invalid package name for npm-dep-versions')
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('A project directory is required for npm-dep-versions')
  let result
  try {
    result = await runProcess('npm-dep-versions', [packageName, '--format', 'json', '--cache-ttl', `${ttlMs / 1000}s`, ...(noCache ? ['--no-cache'] : []), ...(clearCache ? ['--clear-cache'] : [])], projectRoot, spawnImpl, platform)
  }
  catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'npm-dep-versions is not available on PATH; install it as a standalone CLI' : 'Cannot start npm-dep-versions', { cause: error })
  }
  if (result.code !== 0) throw new Error(`npm-dep-versions failed for ${packageName} with exit code ${result.code}; check registry access and the standalone CLI installation`)
  const invalid = () => {
    throw new Error('Invalid npm-dep-versions JSON: expected a fresh schema version 2 stable catalog for the requested package')
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  }
  catch { invalid() }
  if (!report || report.schemaVersion !== 2 || report.package !== packageName || !Array.isArray(report.rows)
    || typeof report.fetchedAt !== 'string' || normalizeTimestamp(report.fetchedAt) !== report.fetchedAt) invalid()
  const age = now() - Date.parse(report.fetchedAt)
  if (!Number.isFinite(age) || age < 0 || age >= ttlMs) invalid()
  const seen = new Set()
  for (const row of report.rows) {
    if (!row || typeof row.version !== 'string' || !isStrictStableVersion(row.version) || seen.has(row.version)
      || (row.releasedAt !== null && (typeof row.releasedAt !== 'string' || normalizeTimestamp(row.releasedAt) !== row.releasedAt))) invalid()
    seen.add(row.version)
  }
  const rows = [...report.rows].sort((a, b) => semver.compare(a.version, b.version) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
  return { versions: rows.map(row => row.version), releaseTimes: new Map(rows.filter(row => row.releasedAt !== null).map(row => [row.version, row.releasedAt])), fetchedAt: report.fetchedAt }
}

// Clear-only request: versions deletes its cache (and its own sibling caches) without analyzing anything.
export async function clearNpmDepVersionsCache(cwd = process.cwd(), spawnImpl = spawn, platform = process.platform) {
  let result
  try {
    result = await runProcess('npm-dep-versions', ['--clear-cache'], cwd, spawnImpl, platform)
  }
  catch (error) {
    throw new Error(error?.code === 'ENOENT' ? 'npm-dep-versions is not available on PATH; install it as a standalone CLI' : 'Cannot start npm-dep-versions', { cause: error })
  }
  if (result.code !== 0) throw new Error(`npm-dep-versions --clear-cache failed with exit code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
}
