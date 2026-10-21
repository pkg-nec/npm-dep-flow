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

export async function npmCommandDirectory(root, runtime) {
  const { mkdir, chmod } = await import('node:fs/promises')
  const directory = join(root, 'commands')
  await mkdir(directory)
  if (process.platform === 'win32') await writeFile(join(directory, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${runtime}" %*\r\n`)
  else {
    const quote = s => '\'' + s.replaceAll('\'', '\'\\\'\'') + '\''
    const file = join(directory, 'npm')
    await writeFile(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runtime)} "$@"\n`)
    await chmod(file, 0o755)
  }
  return directory
}
