function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function attachRequirements(rows, summariesByPackage) {
  if (!Array.isArray(rows)) throw new Error('Audit rows must be an array')
  if (!(summariesByPackage instanceof Map)) throw new Error('npm-dep-paths summaries must be a Map')

  return rows.map(row => {
    if (!isRecord(row) || typeof row.package !== 'string' || typeof row.version !== 'string' ||
        !Array.isArray(row.paths) || row.paths.some(location => typeof location !== 'string')) {
      throw new Error('Cannot attach requirements to a malformed audit row')
    }
    const summary = summariesByPackage.get(row.package)
    if (!isRecord(summary) || !Array.isArray(summary.results)) {
      throw new Error(`Missing npm-dep-paths summary for ${row.package}`)
    }
    const result = summary.results.find(item => item.package === row.package && item.version === row.version)
    if (!result) throw new Error(`npm-dep-paths did not return ${row.package}@${row.version}`)

    const requirements = result.requirements.map(group => ({
      declaredRequirement: group.declaredRequirement,
      directDependents: group.directDependents.filter(item => row.paths.includes(item.targetLocation)),
    })).filter(group => group.directDependents.length > 0)

    const linkedLocations = new Set(requirements.flatMap(group => group.directDependents.map(item => item.targetLocation)))
    const missingLocation = row.paths.find(location => !linkedLocations.has(location))
    if (missingLocation !== undefined) {
      throw new Error(`${missingLocation} is an affected location for ${row.package}@${row.version} with no matching npm-dep-paths link`)
    }

    return { ...row, requirements }
  })
}
