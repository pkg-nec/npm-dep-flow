import { debugAction } from './debug.js'
import npmFetch from 'npm-registry-fetch'
import semver from 'semver'
import { runProcess } from './process.js'
import { fail } from './errors.js'

export function stableVersion(value) {
  if (typeof value !== 'string') return false
  const parsed = semver.parse(value)
  return !!parsed && parsed.prerelease.length === 0 && parsed.format() + (parsed.build.length ? '+' + parsed.build.join('.') : '') === value
}
export function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate() || +m[4] > 23 || +m[5] > 59 || +m[6] > 59 || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}
export async function readCatalog(root, name, context, run = runProcess) {
  const view = async (field) => {
    const r = await run('npm', ['view', name, field, '--json', '--prefer-online'], { cwd: root })
    if (r.code) fail('REGISTRY_FAILED', 'registry', `npm view ${field} failed for ${name}`)
    try {
      return JSON.parse(r.stdout)
    }
    catch { fail('INVALID_REGISTRY', 'registry', `Invalid registry ${field} response`) }
  }
  const versions = await view('versions'), rawTimes = await view('time')
  const times = Array.isArray(rawTimes) && rawTimes.length === 1 ? rawTimes[0] : rawTimes
  const list = typeof versions === 'string' ? [versions] : versions
  if (!Array.isArray(list) || list.some(v => typeof v !== 'string') || (times !== null && (typeof times !== 'object' || Array.isArray(times)))) fail('INVALID_REGISTRY', 'registry', 'Invalid versions or release-time metadata')
  const releaseTimes = new Map(Object.entries(times || {}).flatMap(([v, t]) => {
    const normalized = normalizeTimestamp(t)
    return normalized ? [[v, normalized]] : []
  }))
  return { versions: [...new Set(list.filter(stableVersion))], releaseTimes, minAgeDays: context.minAgeDays, cutoffMs: context.cutoffMs }
}
export async function readCandidateAdvisories(packageVersions, context, fetchImpl = npmFetch) {
  const finish = debugAction('http', { method: 'POST', url: `${(context.auditRegistry || context.registry || '').replace(/\/$/, '')}/-/npm/v1/security/advisories/bulk` })
  const requestOptions = { ...context.requestOptions, registry: context.auditRegistry || context.registry, method: 'POST', gzip: true, body: Object.fromEntries(packageVersions), preferOnline: true, retry: { retries: 0 } }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl('/-/npm/v1/security/advisories/bulk', requestOptions)
      const result = new Map([...packageVersions.keys()].map(name => [name, []]))
      let bytes = 0
      const chunks = []
      for await (const chunk of response.body) {
        const b = Buffer.from(chunk)
        bytes += b.length
        if (bytes > 32 * 1024 * 1024) throw new Error('limit')
        chunks.push(b)
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape')
      for (const [name, entries] of Object.entries(data)) {
        if (!result.has(name) || !Array.isArray(entries)) throw new Error('entries')
        result.set(name, entries.map((a) => {
          const range = a?.vulnerable_versions ?? a?.range
          if (!a || !semver.validRange(range) || (a.name !== undefined && a.name !== name) || !['string', 'number'].includes(typeof a.id)) throw new Error('advisory')
          return { id: a.id, range }
        }))
      }
      finish(`status=${response.status ?? response.statusCode ?? 'success'}`)
      return result
    }
    catch (error) {
      if (attempt === 0 && retryableAdvisoryError(error)) {
        await new Promise(resolve => setTimeout(resolve, 100))
        continue
      }
      finish('error=request-failed')
      fail('SECURITY_FAILED', 'security', 'Candidate advisory security request failed or returned invalid advisory data')
    }
  }
}

function retryableAdvisoryError(error) {
  const status = error?.statusCode ?? error?.status
  return status === 408 || status === 429 || status >= 500 || ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error?.code)
}
