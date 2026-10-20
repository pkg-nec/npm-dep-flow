import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Each standalone tool owns its cache. No sibling private modules are imported.
export async function cachedResult({ tool, version, project, identity = null, query = null, noCache = false, ttlMs = Infinity, cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), tool), now = Date.now }, compute) {
  if (noCache) return (await compute()).value
  const key = digest([1, version, project.root, createHash('sha256').update(project.manifestBytes).digest('hex'), createHash('sha256').update(project.lockBytes).digest('hex'), identity, query])
  const file = join(cacheRoot, `result-${digest([project.root, query])}.json`)
  try {
    const entry = JSON.parse(await readFile(file, 'utf8'))
    const age = now() - entry?.createdAt
    if (entry?.key === key && Number.isFinite(entry.createdAt) && Number.isFinite(age) && age >= 0 && age < ttlMs
      && (entry.expiresAt === null || (Number.isFinite(entry.expiresAt) && now() < entry.expiresAt))
      && entry.checksum === digest([entry.createdAt, entry.expiresAt, entry.value])) {
      return entry.value
    }
  }
  catch { /* Missing, unreadable or malformed cache entries are misses. */ }

  const createdAt = now()
  const { value, expiresAt = null } = await compute()
  const entry = { key, createdAt, expiresAt, value, checksum: digest([createdAt, expiresAt, value]) }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  }
  catch { /* Cache availability must not prevent a valid report. */ }
  finally {
    await unlink(temporary).catch(() => {})
  }
  return value
}
