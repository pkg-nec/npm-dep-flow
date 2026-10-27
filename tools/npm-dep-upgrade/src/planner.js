import { createHash } from 'node:crypto'
import semver from 'semver'
import { runProcess } from './process.js'
import { fail } from './errors.js'
import { PARENT_STRATEGY, STRATEGY, TOOLCHAIN_STRATEGY } from './model.js'
import { ANGULAR_LINES, lineOfStrategy } from './angular-lines.js'

const namePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
export function canonicalLocation(value) {
  const name = '(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*'
  if (typeof value !== 'string' || !new RegExp(`^node_modules/${name}(?:/node_modules/${name})*$`, 'i').test(value)) fail('INVALID_LOCATION', 'planner', 'Invalid canonical installation location')
  return value
}
export function itemId(name, location) {
  return createHash('sha256').update(`${name}__${location}`, 'utf8').digest('hex')
}
export function validatePlanner(report) {
  if (!report || report.schemaVersion !== 3 || !Array.isArray(report.rows) || !Number.isFinite(Date.parse(report.auditedAt))) fail('INVALID_PLAN', 'planner', 'Invalid planner schema version 3 report')
  const ids = new Set()
  for (const row of report.rows) {
    if (!row || !namePattern.test(row.package) || !semver.valid(row.version) || !['none', 'partial', 'complete'].includes(row.resolution) || !Array.isArray(row.choices)) fail('INVALID_PLAN', 'planner', 'Invalid planner row')
    canonicalLocation(row.targetLocation)
    if (row.id !== itemId(row.package, row.targetLocation)) fail('INVALID_PLAN', 'planner', 'Planner item ID does not match package/location')
    if (ids.has(row.id)) fail('INVALID_PLAN', 'planner', 'Duplicate full item ID in planner report')
    ids.add(row.id)
    if (row.minimumSafeVersion !== null && !semver.valid(row.minimumSafeVersion)) fail('INVALID_PLAN', 'planner', 'Invalid minimum safe version')
    if (row.minimumSafeVersionReleasedAt !== null && !Number.isFinite(Date.parse(row.minimumSafeVersionReleasedAt))) fail('INVALID_PLAN', 'planner', 'Invalid release timestamp')
    if ((row.resolution === 'none') !== (row.choices.length === 0)) fail('INVALID_PLAN', 'planner', 'Invalid resolution/action set')
    // A branch may be covered by an ancestor upgrade and by one follow-up action of the other strategy, never twice by one strategy.
    const consumers = new Set()
    const lineChoices = new Map()
    for (const choice of row.choices) {
      if (!choice || ![STRATEGY, PARENT_STRATEGY, ...ANGULAR_LINES.map(line => line.strategy)].includes(choice.strategy) || !Array.isArray(choice.affectedConsumers) || !choice.affectedConsumers.length) fail('INVALID_PLAN', 'planner', 'Invalid or unsupported planner choice')
      if (choice.strategy === STRATEGY) {
        if (choice.targetPackage !== row.package || choice.targetLocation !== row.targetLocation || choice.currentVersion !== row.version || !semver.valid(choice.targetVersion) || !semver.gt(choice.targetVersion, row.version)) fail('INVALID_PLAN', 'planner', 'Invalid or unsupported planner choice')
      }
      else if (lineOfStrategy(choice.strategy)) {
        const line = lineOfStrategy(choice.strategy)
        if (choice.targetPackage !== line.anchor || choice.targetLocation !== `node_modules/${line.anchor}` || !semver.valid(choice.currentVersion) || !semver.valid(choice.targetVersion) || !semver.gt(choice.targetVersion, choice.currentVersion) || semver.major(choice.targetVersion) !== semver.major(choice.currentVersion)) fail('INVALID_PLAN', 'planner', `Invalid Angular ${line.name} choice`)
        if (lineChoices.set(line, (lineChoices.get(line) || 0) + 1).get(line) > 1) fail('INVALID_PLAN', 'planner', `More than one Angular ${line.name} choice`)
      }
      else {
        // The target fields describe the ancestor being upgraded; the covered consumers belong to the selected finding.
        if (typeof choice.targetPackage !== 'string' || !namePattern.test(choice.targetPackage) || choice.targetLocation === row.targetLocation || !semver.valid(choice.currentVersion) || !semver.valid(choice.targetVersion) || !semver.gt(choice.targetVersion, choice.currentVersion)) fail('INVALID_PLAN', 'planner', 'Invalid parent upgrade choice')
        canonicalLocation(choice.targetLocation)
      }
      for (const consumer of choice.affectedConsumers) {
        if (!consumer || typeof consumer.location !== 'string' || !namePattern.test(consumer.requestedName) || !['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].includes(consumer.type)) fail('INVALID_PLAN', 'planner', 'Invalid choice consumer')
        if (consumer.location) canonicalLocation(consumer.location)
        const key = JSON.stringify([choice.strategy, consumer.location, consumer.requestedName, consumer.type])
        if (consumers.has(key)) fail('INVALID_PLAN', 'planner', 'Duplicate choice consumer')
        consumers.add(key)
      }
    }
  }
  return report
}
export function selectItem(report, selector, packageName = null) {
  const found = report.rows.filter(row => row.id.startsWith(selector) && (!packageName || row.package === packageName))
  if (!found.length) fail('TARGET_NOT_FOUND', 'selection', 'Target not found in the current planner report')
  if (found.length !== 1) fail('AMBIGUOUS_TARGET', 'selection', `Ambiguous target; use a longer ID or --package:\n${found.map(r => `${r.id} ${r.package}@${r.version} ${r.targetLocation}`).join('\n')}`)
  const row = found[0]
  if (row.resolution === 'none') fail('INELIGIBLE_TARGET', 'selection', 'Selected target is ineligible')
  if (!Array.isArray(row.choices) || row.choices.some(choice => ![STRATEGY, PARENT_STRATEGY, ...ANGULAR_LINES.map(line => line.strategy)].includes(choice.strategy))) fail('UNSUPPORTED_STRATEGY', 'selection', 'Selected strategy is unsupported')
  return row
}
// Line choices are executed separately in registry order; the rest keeps its order for parent/within-range ordering.
export function splitLines(item) {
  const lines = []
  for (const line of ANGULAR_LINES) {
    const found = item.choices.filter(choice => choice.strategy === line.strategy)
    if (found.length > 1) fail('INVALID_PLAN', 'planner', `More than one Angular ${line.name} choice`)
    if (found.length) lines.push({ line, choice: found[0] })
  }
  if (!lines.length) return { lines, rest: item }
  return { lines, rest: { ...item, choices: item.choices.filter(choice => !lines.some(entry => entry.choice === choice)) } }
}
// Temporary adapter until the CLI is rewired to splitLines.
export function splitToolchain(item) {
  const { lines, rest } = splitLines(item)
  const entry = lines.find(({ line }) => line.strategy === TOOLCHAIN_STRATEGY)
  return { toolchain: entry ? entry.choice : null, rest }
}
export async function readPlanner(root, run = runProcess, { clearCache = false } = {}) {
  const r = await run('npm-dep-upgrade-plan', ['.', '--format', 'json', ...(clearCache ? ['--clear-cache'] : [])], { cwd: root })
  if (r.code) fail('PLANNER_FAILED', 'planner', `npm-dep-upgrade-plan failed: ${r.stderr.trim()}`)
  let report
  try {
    report = JSON.parse(r.stdout)
  }
  catch { fail('INVALID_PLAN', 'planner', 'Planner returned invalid JSON') }
  return validatePlanner(report)
}

// Clear-only request: the planner clears its own and its sibling caches without planning anything.
export async function clearPlannerCache(root, run = runProcess) {
  const r = await run('npm-dep-upgrade-plan', ['--clear-cache'], { cwd: root })
  if (r.code) fail('PLANNER_FAILED', 'planner', `npm-dep-upgrade-plan --clear-cache failed: ${r.stderr.trim()}`)
}
