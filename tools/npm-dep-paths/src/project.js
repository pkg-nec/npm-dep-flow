import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function json(path, label) {
  let bytes
  try { bytes = await readFile(path) }
  catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`, { cause: error }) }
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    if (!object(value)) throw new Error('expected an object')
    return value
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`, { cause: error })
  }
}

function declarations(pkg, where) {
  for (const field of fields) {
    if (pkg[field] === undefined) continue
    if (!object(pkg[field])) throw new Error(`Invalid ${field} in ${where}`)
    for (const [name, spec] of Object.entries(pkg[field])) {
      if (typeof spec !== 'string' || !spec) throw new Error(`Invalid ${field}.${name} in ${where}`)
      if (/^(file:|link:|workspace:)/.test(spec)) throw new Error(`Unsupported local dependency ${name}: ${spec} in ${where}`)
    }
  }
  if (pkg.peerDependenciesMeta !== undefined && !object(pkg.peerDependenciesMeta)) {
    throw new Error(`Invalid peerDependenciesMeta in ${where}`)
  }
}

export async function loadProject(path) {
  const root = await realpath(path)
  try {
    await stat(join(root, 'npm-shrinkwrap.json'))
    throw new Error('Unsupported npm-shrinkwrap.json')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const manifest = await json(join(root, 'package.json'), 'package.json')
  const lock = await json(join(root, 'package-lock.json'), 'package-lock.json')
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('Missing package.json name')
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('Missing package.json version')
  if (manifest.packageManager !== undefined && !/^npm@\S+$/.test(manifest.packageManager)) {
    throw new Error(`Unsupported packageManager: ${manifest.packageManager}`)
  }
  if (![2, 3].includes(lock.lockfileVersion) || !object(lock.packages) || !object(lock.packages[''])) {
    throw new Error('Unsupported package-lock.json lockfileVersion or packages structure; expected version 2 or 3')
  }
  if (manifest.workspaces !== undefined || lock.packages[''].workspaces !== undefined) {
    throw new Error('Unsupported npm workspaces')
  }
  declarations(manifest, 'package.json')
  const rootEntry = lock.packages['']
  if (rootEntry.name !== manifest.name || rootEntry.version !== manifest.version) {
    throw new Error('Stale package-lock.json root name or version mismatch')
  }
  for (const field of fields) {
    const wanted = { ...(manifest[field] || {}) }
    const locked = { ...(rootEntry[field] || {}) }
    if (field === 'dependencies') {
      for (const name of Object.keys(manifest.optionalDependencies || {})) delete wanted[name]
      for (const name of Object.keys(rootEntry.optionalDependencies || {})) delete locked[name]
    }
    if (JSON.stringify(Object.entries(wanted).sort()) !== JSON.stringify(Object.entries(locked).sort())) {
      throw new Error(`Stale package-lock.json root ${field} mismatch`)
    }
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!object(entry)) throw new Error(`Invalid package-lock.json entry ${location}`)
    if (entry.link === true) throw new Error(`Unsupported linked package ${location}`)
    if (typeof entry.resolved === 'string' && /^(file:|link:)/.test(entry.resolved)) {
      throw new Error(`Unsupported local package ${location}`)
    }
    declarations(entry, location || 'lockfile root')
  }
  return { root, manifest, lock }
}
