import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { runProcess } from './process.js'

export async function readContext(root, run = runProcess) {
  root = await realpath(root)
  const output = async (args) => {
    let result
    try {
      result = await run('npm', args, root)
    }
    catch (error) {
      throw new Error('Cannot determine npm cache context; check npm on PATH', { cause: error })
    }
    if (result.code !== 0) throw new Error('Cannot determine npm cache context')
    return result.stdout.trim()
  }
  const [npmVersion, text] = await Promise.all([output(['--version']), output(['config', 'list', '--json'])])
  if (!/^\d+\.\d+\.\d+\b/.test(npmVersion)) throw new Error('Invalid npm version in cache context')
  let config
  try {
    config = JSON.parse(text)
  }
  catch { throw new Error('Invalid npm configuration in cache context') }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid npm configuration in cache context')
  const sorted = Object.entries(config).filter(([key]) => key !== 'before').sort(([a], [b]) => a.localeCompare(b))
  const configHash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
  return { root, npmVersion, configHash }
}
