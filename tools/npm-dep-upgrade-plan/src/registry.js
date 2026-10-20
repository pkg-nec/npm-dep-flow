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

async function npmViewJson(projectRoot, packageName, field, spawnImpl, platform) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw new Error('A project directory is required for npm view')
  }
  if (typeof packageName !== 'string' || !packageNamePattern.test(packageName)) {
    throw new Error(`Invalid package name for npm view: ${packageName}`)
  }

  let result
  try {
    result = await runProcess(
      'npm',
      ['view', packageName, field, '--json'],
      projectRoot,
      spawnImpl,
      platform,
    )
  }
  catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('npm is not available on PATH', { cause: error })
    }
    throw new Error('Cannot start npm view', { cause: error })
  }

  if (result.code !== 0) {
    throw new Error(
      `npm view failed for ${packageName} with exit code ${result.code}; check the package name and npm registry access`,
    )
  }

  try {
    return JSON.parse(result.stdout)
  }
  catch {
    throw new Error('npm view returned invalid JSON')
  }
}

export async function fetchStableVersions(projectRoot, packageName, spawnImpl = spawn, platform = process.platform) {
  const response = await npmViewJson(projectRoot, packageName, 'versions', spawnImpl, platform)
  const published = typeof response === 'string'
    ? [response]
    : Array.isArray(response) && response.every(version => typeof version === 'string')
      ? response
      : null
  if (!published) throw new Error('Invalid npm registry response: expected a string or an array of strings')

  const versions = [...new Set(published.filter(isStrictStableVersion))]
  versions.sort((left, right) => {
    const bySemver = semver.compare(left, right)
    if (bySemver !== 0) return bySemver
    return left < right ? -1 : left > right ? 1 : 0
  })
  return versions
}

export async function fetchReleaseTimes(projectRoot, packageName, spawnImpl = spawn, platform = process.platform) {
  const response = await npmViewJson(projectRoot, packageName, 'time', spawnImpl, platform)
  if (response === null) return new Map()
  if (typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid npm registry response: expected a version release-time object')
  }

  const releaseTimes = new Map()
  for (const [version, value] of Object.entries(response)) {
    if (!isStrictStableVersion(version)) continue
    const releasedAt = normalizeTimestamp(value)
    if (releasedAt !== null) releaseTimes.set(version, releasedAt)
  }
  return releaseTimes
}
