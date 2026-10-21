import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'

export const execute = promisify(execFile)
export async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'versions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.npmrc'), '')
  return root
}
export function registryEnv(root, registry) {
  return { ...process.env, npm_config_registry: registry, npm_config_userconfig: join(root, '.npmrc'), npm_config_cache: join(root, 'npm-cache'), npm_config_offline: 'false', npm_config_fetch_retries: '0', npm_config_update_notifier: 'false' }
}
