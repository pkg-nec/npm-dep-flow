import { realpath, lstat } from 'node:fs/promises'
import path from 'node:path'
import { readDependencyFiles } from './git.js'
import { DEPENDENCY_FIELDS } from './model.js'
import { canonicalLocation } from './planner.js'
import { fail } from './errors.js'
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export async function loadProject(root) {
  root = await realpath(root)
  try { await lstat(path.join(root,'npm-shrinkwrap.json')); fail('UNSUPPORTED_PROJECT','project','Unsupported shrinkwrap') } catch(e) { if(e.code !== 'ENOENT') throw e }
  const files = await readDependencyFiles(root)
  let manifest, lock
  try { manifest = JSON.parse(files['package.json']); lock = JSON.parse(files['package-lock.json']) } catch { fail('INVALID_PROJECT','project','Invalid dependency JSON') }
  if (!object(manifest) || !object(lock) || ![2,3].includes(lock.lockfileVersion) || !object(lock.packages) || !object(lock.packages[''])) fail('INVALID_PROJECT','project','Expected lockfile v2/v3 packages structure')
  if (manifest.workspaces !== undefined || lock.packages[''].workspaces !== undefined) fail('UNSUPPORTED_PROJECT','project','Unsupported workspaces')
  if (manifest.packageManager !== undefined && !/^npm@\S+$/.test(manifest.packageManager)) fail('UNSUPPORTED_PROJECT','project','Unsupported package manager')
  if (lock.packages[''].name !== manifest.name || lock.packages[''].version !== manifest.version) fail('STALE_PROJECT','project','Stale lockfile root metadata')
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location) canonicalLocation(location)
    if (!object(entry) || entry.link || /^(file:|link:)/.test(entry.resolved || '')) fail('UNSUPPORTED_PROJECT','project','Unsupported linked/local package')
    for (const field of DEPENDENCY_FIELDS) for (const spec of Object.values((location ? entry : manifest)[field] || {})) if (typeof spec !== 'string' || /^(file:|link:|workspace:)/.test(spec)) fail('UNSUPPORTED_PROJECT','project','Unsupported dependency requirement')
  }
  for (const field of DEPENDENCY_FIELDS) {
    const wanted = { ...(manifest[field] || {}) }, locked = { ...(lock.packages[''][field] || {}) }
    if (field === 'dependencies') for (const name of Object.keys(manifest.optionalDependencies || {})) { delete wanted[name]; delete locked[name] }
    if (JSON.stringify(Object.entries(wanted).sort()) !== JSON.stringify(Object.entries(locked).sort())) fail('STALE_PROJECT','project',`Stale lockfile root ${field}`)
  }
  return { root, manifest, lock, manifestBytes: files['package.json'], lockBytes: files['package-lock.json'] }
}
