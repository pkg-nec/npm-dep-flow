import { runProcess } from './process.js'

export async function readPathsIdentity(root, run = runProcess) {
  const result = await run('npm-dep-paths', ['--version'], root)
  if (result.code !== 0 || !/^npm-dep-paths v\d+\.\d+\.\d+\b/.test(result.stdout)) {
    throw new Error('Cannot determine npm-dep-paths version; install a supported standalone CLI on PATH')
  }
  return result.stdout.trim()
}
