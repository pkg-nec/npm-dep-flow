import http from 'node:http'

export async function fixtureRegistry(t, { time = true, latest = true } = {}) {
  const calls = []
  const server = http.createServer((req, res) => {
    calls.push(req.url)
    res.setHeader('content-type', 'application/json')
    const versions = Object.fromEntries(['1.0.0', '1.1.0-beta.1'].map(version => [version, { name: 'fixture-package', version }]))
    res.end(JSON.stringify({ 'name': 'fixture-package', 'dist-tags': latest ? { latest: '1.0.0' } : {}, versions, ...(time ? { time: { '1.0.0': '2026-01-01T00:00:00.000Z' } } : {}) }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return { url: `http://127.0.0.1:${server.address().port}`, calls }
}
