import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const TOOL = 'npm-dep-autopilot'
const VERSION = 1
const ID_PATTERN = /^[0-9a-f]{7,64}$/

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function cacheRoot(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.cache'), TOOL)
}

export function storePath(repo, root = cacheRoot()) {
  return join(root, `ignored-${digest(resolve(repo))}.json`)
}

function validEntry(entry) {
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.module === 'string'
    && typeof entry.id === 'string' && ID_PATTERN.test(entry.id)
    && typeof entry.addedAt === 'string'
}

function parseStore(text, repo) {
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.version !== VERSION || value.repo !== resolve(repo)
    || !Array.isArray(value.entries) || !value.entries.every(validEntry)) {
    throw new Error('invalid ignore store')
  }
  return value.entries.map(({ module, id, addedAt }) => ({ module, id, addedAt }))
}

// The result carries the file it read, so a diagnostic about an unreadable
// store can never name a path the read did not use.
export async function readIgnores(repo, root = cacheRoot()) {
  const path = storePath(repo, root)
  let text
  try {
    text = await readFile(path, 'utf8')
  }
  catch (error) {
    return { entries: [], unreadable: error?.code !== 'ENOENT', path }
  }
  try {
    return { entries: parseStore(text, repo), unreadable: false, path }
  }
  catch {
    return { entries: [], unreadable: true, path }
  }
}

// One line listing the stored entries, shared by the run and the --ignore command.
export function ignoreRecord(entries) {
  return entries.length === 0 ? 'none' : entries.map(entry => `${entry.module}:${entry.id} addedAt=${entry.addedAt}`).join(', ')
}

export async function addIgnores(repo, items, root = cacheRoot(), now = () => new Date()) {
  const { entries, unreadable } = await readIgnores(repo, root)
  const stored = [...entries]
  const added = []
  const duplicates = []
  for (const { module, id } of items) {
    if (stored.some(entry => entry.module === module && entry.id === id)) {
      duplicates.push({ module, id })
      continue
    }
    stored.push({ module, id, addedAt: now().toISOString() })
    added.push({ module, id })
  }
  if (added.length > 0 || unreadable) {
    const file = storePath(repo, root)
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await mkdir(root, { recursive: true, mode: 0o700 })
    try {
      await writeFile(temporary, JSON.stringify({ version: VERSION, repo: resolve(repo), entries: stored }), { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    }
    catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
  return { added, duplicates, rebuilt: unreadable }
}

export function isIgnored(entries, module, id) {
  return entries.some(entry => entry.module === module && id.startsWith(entry.id))
}
