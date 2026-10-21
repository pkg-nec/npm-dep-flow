import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isCanonicalVersion, normalizeTimestamp } from './model.js'
import { debugLog } from './debug.js'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function validCatalog(value, name) {
  if (!value || value.schemaVersion !== 2 || value.package !== name || typeof value.fetchedAt !== 'string'
    || normalizeTimestamp(value.fetchedAt) !== value.fetchedAt || !Array.isArray(value.rows)) return false
  const seen = new Set()
  return value.rows.every((row) => {
    if (!row || !isCanonicalVersion(row.version) || seen.has(row.version)
      || (row.releasedAt !== null && (typeof row.releasedAt !== 'string' || normalizeTimestamp(row.releasedAt) !== row.releasedAt))) return false
    seen.add(row.version)
    return true
  })
}

export async function cachedCatalog({ version, root, packageName, identity, ttlMs = 3600000, noCache = false, cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'npm-dep-versions'), now = Date.now }, compute) {
  if (noCache) {
    debugLog('cache bypass catalog')
    return compute()
  }
  const key = digest([2, version, root, packageName, identity])
  const file = join(cacheRoot, `catalog-${digest([root, packageName])}.json`)
  try {
    const entry = JSON.parse(await readFile(file, 'utf8'))
    const age = now() - Date.parse(entry?.value?.fetchedAt)
    if (entry?.key === key && age >= 0 && age < ttlMs && validCatalog(entry.value, packageName) && entry.checksum === digest(entry.value)) {
      debugLog('cache hit catalog')
      return entry.value
    }
  }
  catch { /* Missing or invalid caches are misses. */ }
  debugLog('cache miss catalog')
  const value = await compute()
  if (!validCatalog(value, packageName)) throw new Error('Invalid version catalog')
  const entry = { key, value, checksum: digest(value) }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  }
  catch { /* Storage availability must not prevent a valid report. */ }
  finally { await unlink(temporary).catch(() => {}) }
  return value
}
