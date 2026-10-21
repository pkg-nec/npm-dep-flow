import { readNpmConfiguration } from './config-identity.js'
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

export async function readPlanningContext(root, run = runProcess, env = process.env) {
  const [npmVersion, configHash, audit, paths, versions] = await Promise.all([
    output(root, 'npm', ['--version'], run),
    readNpmConfiguration(root, run, env),
    output(root, 'npm-dep-audit', ['--version'], run),
    output(root, 'npm-dep-paths', ['--version'], run),
    output(root, 'npm-dep-versions', ['--version'], run),
  ])
  if (!/^\d+\.\d+\.\d+\b/.test(npmVersion)
    || !/^npm-dep-audit v\d+\.\d+\.\d+\b/.test(audit)
    || !/^npm-dep-paths v\d+\.\d+\.\d+\b/.test(paths)
    || !/^npm-dep-versions v\d+\.\d+\.\d+\b[\s\S]*\nLocation: \S/.test(versions)) throw new Error('Invalid tool version in planner cache context')
  return { npmVersion, configHash, audit, paths, versions }
}
