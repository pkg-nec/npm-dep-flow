import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { debugSpawn } from './debug.js'
import { readResolverRuntime } from './npm-runtime.js'

export async function runWorker(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = debugSpawn(spawn, process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) child.kill()
      else stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) child.kill()
      else stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

// Registry metadata reuse follows the planner TTL under the planner's cache directory; a bypass or an unknown planning
// context keeps the worker's metadata in memory only.
function packumentCacheFor({ noCache = false, ttlMs, packumentIdentity, env = process.env }) {
  if (noCache || packumentIdentity == null) return null
  const cacheHome = env.XDG_CACHE_HOME || path.join(env.HOME || homedir(), '.cache')
  return { dir: path.join(cacheHome, 'npm-dep-upgrade-plan', 'packuments'), ttlMs, identity: createHash('sha256').update(JSON.stringify([1, packumentIdentity])).digest('hex') }
}

export async function resolveChoices(project, item, choices, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'npm-dep-plan-resolve-'))
  try {
    const runtime = await (options.readRuntime || readResolverRuntime)(project.root, { env: options.env })
    await Promise.all(['package.json', 'package-lock.json'].map(async n => writeFile(path.join(root, n), await readFile(path.join(project.root, n)))))
    const request = path.join(root, 'request.json')
    await writeFile(request, JSON.stringify({ root, projectRoot: project.root, npmPath: runtime.npmPath, item, choices, releaseTimes: options.releaseTimes || {}, packumentCache: packumentCacheFor(options), startedAt: Date.now() }), { mode: 0o600 })
    const response = await (options.run || runWorker)([fileURLToPath(new URL('./resolver-worker.js', import.meta.url)), request], options)
    if (response.code) throw new Error('Dependency resolver failed')
    let result
    try {
      result = JSON.parse(response.stdout)
    }
    catch { throw new Error('Invalid resolver output') }
    if (result?.schemaVersion !== 1 || !Array.isArray(result.choices) || !['none', 'partial', 'complete'].includes(result.coverage?.resolution) || !Array.isArray(result.graph?.nodes) || !Number.isFinite(result.freshAt)) throw new Error('Invalid resolver evidence')
    return result
  }
  finally { await rm(root, { recursive: true, force: true }) }
}
