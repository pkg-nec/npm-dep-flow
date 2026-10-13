import semver from 'semver'

const packageNamePattern = /^(?:[a-z0-9][a-z0-9._~-]*|@[^/@\s]+\/[^/@\s]+)$/i

export function parseSelector(input) {
  if (typeof input !== 'string' || !input) throw new Error('Invalid package selector')
  const separator = input.lastIndexOf('@')
  const hasVersion = separator > 0
  const name = hasVersion ? input.slice(0, separator) : input
  if (!packageNamePattern.test(name)) throw new Error(`Invalid package selector: ${input}`)
  if (!hasVersion) return { kind: 'name', name }
  const version = input.slice(separator + 1)
  if (semver.valid(version) === null) throw new Error(`Expected an exact package version in selector: ${input}`)
  return { kind: 'exact', name, version }
}
