import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// npm redacts protected fields in config output. Hash the active source files
// and their environment substitutions in memory; persist only the final digest.
export async function readNpmConfiguration(root, run, env = process.env) {
  const query = async (args, cwd = root) => {
    try {
      return await run('npm', args, cwd)
    }
    catch (error) {
      throw new Error('Cannot determine npm cache context; check npm on PATH', { cause: error })
    }
  }
  let configRoot = root
  let result = await query(['config', 'list', '--json'])
  // Config rejects implicit workspaces, whereas view and prefix ignore them.
  // Query at npm's resolved root without disabling workspace root discovery or
  // overriding prefix (either would change the active project/global npmrc).
  if (result.code !== 0 && /ENOWORKSPACES/.test(result.stderr || '')) {
    const prefix = await query(['prefix'])
    if (prefix.code !== 0 || !isAbsolute(prefix.stdout.trim())) throw new Error('Cannot resolve npm configuration directory')
    configRoot = await realpath(prefix.stdout.trim())
    result = await query(['config', 'list', '--json'], configRoot)
  }
  if (result.code !== 0) throw new Error('Cannot determine npm cache context')
  let config
  try {
    config = JSON.parse(result.stdout)
  }
  catch { throw new Error('Invalid npm configuration in cache context') }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid npm configuration in cache context')
  const listing = await query(['config', 'list', '--json=false'], configRoot)
  if (listing.code !== 0) throw new Error('Cannot determine npm configuration sources')
  const sources = [...new Set([...listing.stdout.matchAll(/^; "(?:builtin|global|user|project)" config from (.+)\r?$/gm)].map(match => match[1].trimEnd()))].sort()
  const referenced = new Set()
  const files = []
  for (const source of sources) {
    if (!isAbsolute(source)) throw new Error('Invalid npm configuration source')
    let text
    try {
      text = await readFile(source, 'utf8')
    }
    catch (error) {
      throw new Error('Cannot read npm configuration source for cache identity', { cause: error })
    }
    text = text.split(/\r?\n/).filter(line => !/^\s*before\s*=/i.test(line)).join('\n')
    for (const match of text.matchAll(/\$\{([^${}?]+)\??\}/g)) referenced.add(match[1])
    files.push([source, digest(text)])
  }
  const environment = Object.entries(env).filter(([key]) => (/^npm_config_/i.test(key) && key.toLowerCase() !== 'npm_config_before')
    || /^(?:https?_proxy|all_proxy|no_proxy)$/i.test(key) || referenced.has(key)).sort(([a], [b]) => a.localeCompare(b))
  const publicConfig = Object.entries(config).filter(([key]) => key !== 'before').sort(([a], [b]) => a.localeCompare(b))
  return digest([publicConfig, files, environment])
}
