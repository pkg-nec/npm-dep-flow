import { spawn } from 'node:child_process'
import semver from 'semver'
import { runProcess } from './process.js'

const packageNamePattern = /^(?:[a-z0-9][a-z0-9._~-]*|@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*)$/i

function isStrictStableVersion(value) {
  const parsed = semver.parse(value)
  if (!parsed || parsed.prerelease.length > 0) return false
  const buildMetadata = value.includes('+') ? value.slice(value.indexOf('+')) : ''
  return `${parsed.format()}${buildMetadata}` === value
}

export async function fetchStableVersions(projectRoot, packageName, spawnImpl = spawn, platform = process.platform) {
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
      ['view', packageName, 'versions', '--json'],
      projectRoot,
      spawnImpl,
      platform,
    )
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('npm is not available on PATH', { cause: error })
    }
    throw new Error('Cannot start npm view', { cause: error })
  }

  if (result.code !== 0) {
    throw new Error(`npm view failed with exit code ${result.code}`)
  }

  let response
  try {
    response = JSON.parse(result.stdout)
  } catch {
    throw new Error('npm view returned invalid JSON')
  }

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
