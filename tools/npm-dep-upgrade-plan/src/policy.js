import { runProcess } from './process.js'

const DAY_MS = 86_400_000
export const MIN_RELEASE_AGE_FLOOR_DAYS = 7

// Same rule as the mutator: the configured min-release-age, never below seven days, bounded by an explicit `before`.
export async function readReleasePolicy(root, run = runProcess) {
  let result
  try {
    result = await run('npm', ['config', 'list', '--json'], root)
  }
  catch (error) {
    throw new Error('Cannot determine the release-age policy from npm configuration', { cause: error })
  }
  let config
  try {
    if (result.code !== 0) throw new Error('failed')
    config = JSON.parse(result.stdout)
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('shape')
  }
  catch { throw new Error('Cannot determine the release-age policy from npm configuration') }
  const configured = config['min-release-age'] === undefined || config['min-release-age'] === null ? 0 : Number(config['min-release-age'])
  const cutoffMs = config.before ? Date.parse(config.before) : null
  if (!Number.isFinite(configured) || configured < 0 || (config.before && !Number.isFinite(cutoffMs))) throw new Error('Invalid release-age policy in npm configuration')
  return { minAgeDays: Math.max(MIN_RELEASE_AGE_FLOOR_DAYS, configured), cutoffMs }
}

export function effectiveCutoff(policy, now = Date.now()) {
  return Math.min(now - policy.minAgeDays * DAY_MS, policy.cutoffMs ?? Infinity)
}
