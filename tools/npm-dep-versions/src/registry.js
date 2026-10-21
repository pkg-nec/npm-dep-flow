import { runProcess } from './process.js'
import { normalizeCatalogResponse, packageNamePattern } from './model.js'

export async function fetchCatalog(root, packageName, { run = runProcess, now = Date.now } = {}) {
  if (typeof packageName !== 'string' || !packageNamePattern.test(packageName)) throw new Error('Invalid package name')
  if (typeof root !== 'string' || !root) throw new Error('An npm context directory is required')
  const fetchedAt = new Date(now()).toISOString()
  let result
  try {
    result = await run('npm', ['view', packageName, 'versions', 'time', '--json'], root)
  }
  catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'npm is not available on PATH' : 'Cannot start npm view', { cause: error })
  }
  if (result.code !== 0) throw new Error(`npm view failed for ${packageName}; check package name and npm registry access`)
  let raw
  try {
    raw = JSON.parse(result.stdout)
  }
  catch { throw new Error('npm view returned invalid JSON') }
  return { schemaVersion: 2, package: packageName, fetchedAt, rows: normalizeCatalogResponse(raw) }
}
