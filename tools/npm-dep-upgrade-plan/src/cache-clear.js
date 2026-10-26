import { debugLog } from './debug.js'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Each standalone tool owns its cache. No sibling private modules are imported.
export async function clearCache({ tool, cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), tool) }) {
  debugLog('cache clear')
  await rm(cacheRoot, { recursive: true, force: true })
}
