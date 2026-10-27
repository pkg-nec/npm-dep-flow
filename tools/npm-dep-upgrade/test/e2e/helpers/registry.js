import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import semver from 'semver'
import { tarball } from './tarballs.js'
export async function startRegistry(scenario) {
  const state = { phase: 'seed', url: '' }
  const setPhase = (p) => {
    state.phase = p
  }
  const calls = [], unexpected = [], archives = new Map()
  for (const [name, versions] of Object.entries(scenario.packages)) for (const [version, p] of Object.entries(versions)) archives.set(`${name}@${version}`, tarball(p.manifest))
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let body = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body)
      const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname)
      const call = { path: pathname, method: req.method, phase: state.phase, body: body.length ? JSON.parse(body) : null, encoding: req.headers['content-encoding'] }
      calls.push(call)
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
        res.end(JSON.stringify(value))
      }
      if (pathname === '/__checkpoint') return reply(200, await scenario.checkpoint?.(call.body) || {})
      const fault = await scenario.request?.({ call, phase: state.phase, setPhase })
      if (fault?.raw) {
        res.writeHead(fault.status || 200)
        res.end(fault.raw)
        return
      }
      if (fault) return reply(fault.status || 500, fault.body || { error: 'fixture failure' })
      if (pathname === '/-/npm/v1/security/advisories/bulk') {
        const result = {}
        const advisories = typeof scenario.advisories === 'function' ? scenario.advisories(state.phase) : scenario.advisories
        for (const a of advisories) if ((call.body[a.name] || []).some(v => semver.satisfies(v, a.range))) (result[a.name] ??= []).push({ id: a.id, name: a.name, title: 'controlled vulnerability', url: 'https://example.invalid/advisory/' + a.id, severity: 'high', vulnerable_versions: a.range, cwe: ['CWE-400'], cvss: { score: 7, vectorString: null } })
        return reply(200, result)
      }
      if (pathname.startsWith('/tarballs/')) {
        const key = pathname.slice(10, -4), archive = archives.get(key)
        if (archive) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end(archive.bytes)
          return
        }
      }
      const name = pathname.slice(1), catalog = scenario.packages[name]
      if (catalog) {
        const entries = Object.entries(catalog).filter(([v, p]) => state.phase !== 'seed' || (p.seed !== false && (!(scenario.targets || []).includes(name) || v === '6.0.9' || v.startsWith('7.'))))
        const versions = {}, time = { created: '2020-01-01T00:00:00.000Z', modified: new Date().toISOString() }
        for (const [v, p] of entries) {
          const archive = archives.get(`${name}@${v}`)
          versions[v] = { ...p.manifest, _id: `${name}@${v}`, dist: { tarball: `${state.url}/tarballs/${encodeURIComponent(name + '@' + v)}.tgz`, integrity: archive.integrity, shasum: archive.shasum } }
          if (p.releasedAt !== undefined) time[v] = p.releasedAt
        }
        const latest = entries.map(([v]) => v).filter(v => !semver.prerelease(v)).sort(semver.rcompare)[0]
        return reply(200, { name, '_id': name, 'dist-tags': { latest }, versions, time })
      }
      unexpected.push(call)
      reply(404, { error: 'unexpected fixture request' })
    }
    catch (error) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: error.message }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  state.url = `http://127.0.0.1:${server.address().port}`
  return { url: state.url, calls, unexpected, setPhase, close: () => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }) }
}
