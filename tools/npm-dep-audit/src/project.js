import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(bytes, name) {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (!isObject(value)) throw new Error('expected an object')
    return value
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error.message}`, { cause: error })
  }
}

function rejectLocalSpecs(pkg, location) {
  for (const field of dependencyFields) {
    if (pkg[field] === undefined) continue
    if (!isObject(pkg[field])) throw new Error(`Invalid ${field} in ${location}`)
    for (const spec of Object.values(pkg[field])) {
      if (typeof spec === 'string' && /^(file:|link:|workspace:)/.test(spec)) {
        throw new Error(`Unsupported local dependency ${spec} in ${location}`)
      }
    }
  }
}

export async function loadProject(path) {
  const root = await realpath(path)
  try {
    await stat(join(root, 'npm-shrinkwrap.json'))
    throw new Error('Unsupported npm-shrinkwrap.json; npm would audit it instead of package-lock.json')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  let manifestBytes
  let lockBytes
  try { manifestBytes = await readFile(join(root, 'package.json')) }
  catch (error) { throw new Error(`Cannot read package.json: ${error.message}`, { cause: error }) }
  try { lockBytes = await readFile(join(root, 'package-lock.json')) }
  catch (error) { throw new Error(`Cannot read package-lock.json: ${error.message}`, { cause: error }) }

  const manifest = parseJson(manifestBytes, 'package.json')
  const lock = parseJson(lockBytes, 'package-lock.json')
  if (manifest.packageManager !== undefined &&
      (typeof manifest.packageManager !== 'string' || !/^npm@\S+$/.test(manifest.packageManager))) {
    throw new Error(`Unsupported packageManager: ${manifest.packageManager}`)
  }
  if (![2, 3].includes(lock.lockfileVersion) || !isObject(lock.packages) || !isObject(lock.packages[''])) {
    throw new Error('Unsupported package-lock.json lockfileVersion or packages structure; expected version 2 or 3')
  }
  if (manifest.workspaces !== undefined || lock.packages[''].workspaces !== undefined) {
    throw new Error('Unsupported npm workspaces')
  }
  rejectLocalSpecs(manifest, 'package.json')
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!isObject(pkg)) throw new Error(`Invalid package entry ${location}`)
    if (pkg.link === true) throw new Error(`Unsupported linked package ${location}`)
    if (typeof pkg.resolved === 'string' && /^(file:|link:)/.test(pkg.resolved)) {
      throw new Error(`Unsupported local package ${location}`)
    }
    rejectLocalSpecs(pkg, location)
  }
  return { root, manifestBytes, lockBytes, lock }
}
