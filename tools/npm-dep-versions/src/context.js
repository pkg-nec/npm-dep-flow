import { realpath } from 'node:fs/promises'
import { runProcess } from './process.js'
import { readNpmConfiguration } from './config-identity.js'

export async function readContext(root, run = runProcess, env = process.env) {
  root = await realpath(root)
  const version = async () => {
    let result
    try {
      result = await run('npm', ['--version'], root)
    }
    catch (error) {
      throw new Error('Cannot determine npm cache context; check npm on PATH', { cause: error })
    }
    if (result.code !== 0) throw new Error('Cannot determine npm cache context')
    return result.stdout.trim()
  }
  const [npmVersion, configHash] = await Promise.all([version(), readNpmConfiguration(root, run, env)])
  if (!/^\d+\.\d+\.\d+\b/.test(npmVersion)) throw new Error('Invalid npm version in cache context')
  return { root, npmVersion, configHash }
}
