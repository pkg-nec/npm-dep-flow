import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { runNpmAudit, validateAudit } from './npm-audit.js'

const schemaVersion = 1

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprint(project, context) {
  const hash = createHash('sha256')
  const parts = [
    Buffer.from(`npm-dep-audit-cache-v${schemaVersion}`),
    Buffer.from(project.root),
    project.manifestBytes,
    project.lockBytes,
    Buffer.from(context.version),
    Buffer.from(context.registry),
  ]
  for (const part of parts) {
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(part.length))
    hash.update(length).update(part)
  }
  return hash.digest('hex')
}

function defaultRoot() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'npm-dep-audit')
}

export async function getAudit(project, context, {
  ttlMs = 3600000,
  noCache = false,
  cacheRoot = defaultRoot(),
  now = Date.now,
  fetchAudit = () => runNpmAudit(project.root),
} = {}) {
  if (noCache) {
    const audit = validateAudit(await fetchAudit())
    return { audit, auditedAt: new Date(now()).toISOString() }
  }

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  const file = join(cacheRoot, `${digest(project.root)}.json`)
  const key = fingerprint(project, context)
  try {
    const entry = JSON.parse(await readFile(file, 'utf8'))
    if (entry && typeof entry === 'object' && !Array.isArray(entry) &&
        Number.isFinite(entry.timestamp) && Math.abs(entry.timestamp) <= 8.64e15) {
      const age = now() - entry.timestamp
      let auditValid = false
      try { validateAudit(entry.audit); auditValid = true } catch { /* invalid cache is a miss */ }
      if (entry.key === key && auditValid && Number.isFinite(age) && age >= 0 && age < ttlMs &&
          entry.auditedAt === new Date(entry.timestamp).toISOString()) {
        return { audit: entry.audit, auditedAt: entry.auditedAt }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }

  const audit = validateAudit(await fetchAudit())
  const timestamp = now()
  const auditedAt = new Date(timestamp).toISOString()
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ key, timestamp, auditedAt, audit }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return { audit, auditedAt }
}
