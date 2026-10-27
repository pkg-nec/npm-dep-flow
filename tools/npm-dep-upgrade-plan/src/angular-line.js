import semver from 'semver'
import { strictStableVersion } from './strategies.js'

function requestedTypeOf(manifest, name) {
  for (const type of ['dependencies', 'devDependencies']) {
    if (manifest?.[type] && Object.hasOwn(manifest[type], name)) return type
  }
  return null
}

export function lineMembers(line, manifest, lockPackages) {
  if (requestedTypeOf(manifest, line.anchor) === null) return null

  const members = []
  for (const name of line.members) {
    const requestedType = requestedTypeOf(manifest, name)
    if (requestedType === null) continue
    const location = `node_modules/${name}`
    const version = lockPackages?.[location]?.version
    if (typeof version !== 'string') return null
    members.push({ name, location, version, requestedType })
  }

  if (!members.some(member => member.name === line.anchor)) return null
  const version = members[0].version
  if (members.some(member => member.version !== version)) return null
  return { members, version }
}

export function lineCandidateVersions(currentVersion, catalogVersions) {
  const current = semver.parse(currentVersion)
  if (!current) return []
  return [...new Set(catalogVersions)]
    .filter(version => strictStableVersion(version)
      && semver.major(version) === current.major
      && semver.gt(version, current))
    .sort(semver.compare)
}

export function inLineScope(consumerLocation, graph, members) {
  const locations = new Set(members.map(member => member.location))
  if (consumerLocation === '') return graph.edges.some(edge => edge.from === '' && locations.has(edge.to))
  if (locations.has(consumerLocation)) return true
  return graph.edges.some(edge => edge.to === consumerLocation && locations.has(edge.from))
}
