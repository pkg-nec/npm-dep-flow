import { debugLog } from './debug.js'
import { cacheRoot, storePath } from './ignores.js'
import { rm } from 'node:fs/promises'

// Removes one clone's ignore store; a missing file is not an error.
export async function clearStore(repo, root = cacheRoot()) {
  debugLog('cache clear')
  await rm(storePath(repo, root), { recursive: true, force: true })
}

// Removes autopilot's whole cache directory; a missing directory is not an error.
export async function clearAllStores(root = cacheRoot()) {
  debugLog('cache clear')
  await rm(root, { recursive: true, force: true })
}
