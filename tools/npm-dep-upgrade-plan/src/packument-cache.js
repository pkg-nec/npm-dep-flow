import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const digest = value => createHash('sha256').update(value).digest('hex')
const DAY_MS = 86_400_000
const STORE_FILE = /^[0-9a-f]{64}\.json\.gz(?:\..+\.tmp)?$/
const removeQuietly = (file) => {
  try {
    unlinkSync(file)
  }
  catch { /* Removal is best effort. */ }
}

// The planner's own registry metadata store, handed to npm's resolver as its `packumentCache` (pacote calls has/get/
// set/delete synchronously). Entries live for the planner TTL from their original fetch, and reuse never extends that.
// File names hash the identity and pacote's key, so registry URLs, which may carry credentials, never reach disk.
// Without a directory and identity the store is memory-only. Storage failures never fail a resolution.
// `required` maps package names to versions this check targets; an entry fetched before one of them was published is a
// miss, so a release the (separately cached) catalog already offers is never resolved against older metadata.
export function createPackumentCache({ dir = null, identity = null, ttlMs = 0, now = Date.now, required = {} } = {}) {
  const memory = new Map()
  const stats = { diskHits: 0, misses: 0 }
  let oldestFetchedAt = Infinity
  const disk = typeof dir === 'string' && typeof identity === 'string'
  const fileOf = key => join(dir, `${digest(JSON.stringify([1, identity, key]))}.json.gz`)

  // Entries orphaned by a planner, npm or configuration change, or by a package leaving every project, are never looked
  // up again, so each store first removes files nobody has written for longer than max(TTL, one day).
  if (disk) {
    let names = []
    try {
      names = readdirSync(dir)
    }
    catch { /* A missing or unreadable directory has nothing to sweep. */ }
    for (const name of names.filter(entry => STORE_FILE.test(entry))) {
      try {
        if (now() - statSync(join(dir, name)).mtimeMs > Math.max(ttlMs, DAY_MS)) unlinkSync(join(dir, name))
      }
      catch { /* Sweeping is best effort. */ }
    }
  }

  const readEntry = (key) => {
    const file = fileOf(key)
    let entry
    try {
      entry = JSON.parse(gunzipSync(readFileSync(file)).toString())
    }
    catch (error) {
      if (error?.code !== 'ENOENT') removeQuietly(file)
      return undefined
    }
    const age = now() - entry?.fetchedAt
    const valid = Number.isFinite(entry?.fetchedAt) && age >= 0 && age < ttlMs
      && entry.checksum === digest(JSON.stringify([entry.fetchedAt, entry.packument]))
    if (!valid) {
      removeQuietly(file)
      return undefined
    }
    const versions = entry.packument?.versions ?? {}
    if ((required[entry.packument?.name] ?? []).some(version => !Object.hasOwn(versions, version))) return undefined
    return entry
  }

  const writeEntry = (key, packument) => {
    const file = fileOf(key)
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      const fetchedAt = now()
      const body = gzipSync(JSON.stringify({ fetchedAt, checksum: digest(JSON.stringify([fetchedAt, packument])), packument }))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
    }
    catch {
      removeQuietly(temporary)
    }
  }

  return {
    has(key) {
      if (memory.has(key)) return true
      const entry = disk ? readEntry(key) : undefined
      if (!entry) {
        stats.misses++
        return false
      }
      memory.set(key, entry.packument)
      stats.diskHits++
      oldestFetchedAt = Math.min(oldestFetchedAt, entry.fetchedAt)
      return true
    },
    get(key) {
      return memory.get(key)
    },
    set(key, packument) {
      memory.set(key, packument)
      if (disk) writeEntry(key, packument)
    },
    delete(key) {
      memory.delete(key)
      if (disk) removeQuietly(fileOf(key))
    },
    get oldestFetchedAt() {
      return oldestFetchedAt
    },
    get stats() {
      return { ...stats }
    },
  }
}
