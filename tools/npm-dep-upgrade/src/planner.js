import { createHash } from 'node:crypto'
import semver from 'semver'
import { runProcess } from './process.js'
import { fail } from './errors.js'
import { STRATEGY } from './model.js'
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
  if (!report || report.schemaVersion !== 2 || !Array.isArray(report.rows) || !Number.isFinite(Date.parse(report.auditedAt))) fail('INVALID_PLAN', 'planner', 'Invalid planner schema version 2 report')
  const ids = new Set()
  for (const row of report.rows) {
    if (!row || !namePattern.test(row.package) || !semver.valid(row.version) || !['eligible', 'ineligible'].includes(row.status)) fail('INVALID_PLAN', 'planner', 'Invalid planner row')
    canonicalLocation(row.targetLocation)
    if (row.id !== itemId(row.package, row.targetLocation)) fail('INVALID_PLAN', 'planner', 'Planner item ID does not match package/location')
    if (ids.has(row.id)) fail('INVALID_PLAN', 'planner', 'Duplicate full item ID in planner report')
    ids.add(row.id)
    if (row.minimumSafeVersion !== null && !semver.valid(row.minimumSafeVersion)) fail('INVALID_PLAN', 'planner', 'Invalid minimum safe version')
    if (row.minimumSafeVersionReleasedAt !== null && !Number.isFinite(Date.parse(row.minimumSafeVersionReleasedAt))) fail('INVALID_PLAN', 'planner', 'Invalid release timestamp')
    if (row.status === 'eligible' && (!row.minimumSafeVersion || !row.strategy || row.strategy.targetPackage !== row.package || row.strategy.currentVersion !== row.version || !semver.valid(row.strategy.targetVersion))) fail('INVALID_PLAN', 'planner', 'Invalid eligible strategy')
    if (row.status === 'ineligible' && row.strategy !== null) fail('INVALID_PLAN', 'planner', 'Invalid ineligible strategy')
  }
  return report
}
export function selectItem(report, selector, packageName = null) {
  const found = report.rows.filter(row => row.id.startsWith(selector) && (!packageName || row.package === packageName))
  if (!found.length) fail('TARGET_NOT_FOUND', 'selection', 'Target not found in the current planner report')
  if (found.length !== 1) fail('AMBIGUOUS_TARGET', 'selection', `Ambiguous target; use a longer ID or --package:\n${found.map(r => `${r.id} ${r.package}@${r.version} ${r.targetLocation}`).join('\n')}`)
  const row = found[0]
  if (row.status !== 'eligible') fail('INELIGIBLE_TARGET', 'selection', 'Selected target is ineligible')
  if (row.strategy?.id !== STRATEGY) fail('UNSUPPORTED_STRATEGY', 'selection', 'Selected strategy is unsupported')
  return row
}
export async function readPlanner(root, run = runProcess) {
  const r = await run('npm-dep-upgrade-plan', ['.', '--format', 'json'], { cwd: root })
  if (r.code) fail('PLANNER_FAILED', 'planner', `npm-dep-upgrade-plan failed: ${r.stderr.trim()}`)
  let report
  try {
    report = JSON.parse(r.stdout)
  }
  catch { fail('INVALID_PLAN', 'planner', 'Planner returned invalid JSON') }
  return validatePlanner(report)
}
