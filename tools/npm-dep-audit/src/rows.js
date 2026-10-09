import semver from 'semver'

const levels = ['info', 'low', 'moderate', 'high', 'critical']

function packageName(location) {
  const marker = 'node_modules/'
  const index = location.lastIndexOf(marker)
  if (index < 0) throw new Error(`Cannot derive package name from ${location}`)
  return location.slice(index + marker.length)
}

function normalizeAdvisory(via) {
  const range = via.range ?? via.vulnerable_versions
  if (typeof range !== 'string' || semver.validRange(range) === null) {
    throw new Error(`Unsupported advisory range for ${via.name ?? via.title ?? 'package'}`)
  }
  if (!levels.includes(via.severity)) throw new Error(`Unsupported advisory severity ${via.severity}`)
  const id = via.source ?? via.id ?? via.url
  if (id === undefined) throw new Error('Advisory has no source identifier or URL')
  return { id, title: via.title ?? String(id), url: via.url ?? '', severity: via.severity, range }
}

export function buildRows(lock, audit) {
  const grouped = new Map()
  for (const vuln of Object.values(audit.vulnerabilities)) {
    if (!Array.isArray(vuln.via) || !Array.isArray(vuln.nodes)) throw new Error('Invalid vulnerability via or nodes')
    const direct = vuln.via.filter(via => typeof via !== 'string').map(via => {
      if (!via || typeof via !== 'object' || Array.isArray(via)) throw new Error('Invalid advisory via entry')
      return normalizeAdvisory(via)
    })
    if (direct.length === 0) continue
    for (const location of vuln.nodes) {
      const entry = lock.packages[location]
      if (!entry || typeof entry.version !== 'string') {
        throw new Error(`Missing lockfile version for affected path ${location}`)
      }
      const name = entry.name || packageName(location)
      const matching = direct.filter(a => semver.satisfies(entry.version, a.range, { includePrerelease: true, loose: true }))
      if (matching.length === 0) continue
      const key = JSON.stringify([name, entry.version])
      if (!grouped.has(key)) grouped.set(key, { package: name, version: entry.version, severity: 'info', advisories: new Map(), paths: new Set() })
      const row = grouped.get(key)
      row.paths.add(location)
      for (const advisory of matching) {
        row.advisories.set(String(advisory.id), advisory)
        if (levels.indexOf(advisory.severity) > levels.indexOf(row.severity)) row.severity = advisory.severity
      }
    }
  }
  return [...grouped.values()].map(row => ({
    package: row.package,
    version: row.version,
    severity: row.severity,
    advisories: [...row.advisories.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en')),
    paths: [...row.paths].sort((a, b) => a.localeCompare(b, 'en')),
  })).sort((a, b) => a.package.localeCompare(b.package, 'en') || semver.compare(a.version, b.version))
}

export function selectRows(rows, minSeverity) {
  const threshold = levels.indexOf(minSeverity)
  if (threshold < 0) throw new Error(`Unsupported minimum severity ${minSeverity}`)
  return rows.filter(row => levels.indexOf(row.severity) >= threshold)
    .sort((a, b) => levels.indexOf(b.severity) - levels.indexOf(a.severity) ||
      a.package.localeCompare(b.package, 'en') || semver.compare(a.version, b.version))
}
