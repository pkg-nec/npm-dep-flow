import { createHash } from 'node:crypto'
import { runProcess } from './process.js'

async function output(root, command, args, run) {
  let result
  try {
    result = await run(command, args, root)
  }
  catch (error) {
    throw new Error(error.code === 'ENOENT' ? `${command} is not available on PATH; install it as a standalone CLI` : `Cannot determine cache context: ${command} failed`, { cause: error })
  }
  if (result.code !== 0) throw new Error(`Cannot determine cache context: ${command} ${args.join(' ')} failed`)
  return result.stdout.trim()
}

export async function readPlanningContext(root, run = runProcess) {
  const [npmVersion, configuration, audit, paths, versions] = await Promise.all([
    output(root, 'npm', ['--version'], run),
    output(root, 'npm', ['config', 'list', '--json'], run),
    output(root, 'npm-dep-audit', ['--version'], run),
    output(root, 'npm-dep-paths', ['--version'], run),
    output(root, 'npm-dep-versions', ['--version'], run),
  ])
  if (!/^\d+\.\d+\.\d+\b/.test(npmVersion)
    || !/^npm-dep-audit v\d+\.\d+\.\d+\b/.test(audit)
    || !/^npm-dep-paths v\d+\.\d+\.\d+\b/.test(paths)
    || !/^npm-dep-versions v\d+\.\d+\.\d+\b[\s\S]*\nLocation: \S/.test(versions)) throw new Error('Invalid tool version in planner cache context')
  let config
  try {
    config = JSON.parse(configuration)
  }
  catch { throw new Error('Invalid npm configuration in planner cache context') }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid npm configuration in planner cache context')
  // npm 11 converts min-release-age into a moving `before` timestamp. The
  // planner queries complete version/time metadata and direct advisories, which
  // do not use this installation cutoff. Upgrade enforces the current policy
  // independently. Keep the cutoff out of analysis cache identity.
  // Persist only a digest, never configuration values or credentials.
  const analysisConfig = Object.entries(config).filter(([key]) => key !== 'before')
  const configHash = createHash('sha256').update(JSON.stringify(analysisConfig.sort(([a], [b]) => a.localeCompare(b)))).digest('hex')
  return { npmVersion, configHash, audit, paths, versions }
}
