// CI setup only. Network access ends before registry-isolated E2E cases start.
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import crossSpawn from 'cross-spawn'
const scratch = path.resolve(process.env.NPM_DEP_FLOW_TEST_TMPDIR || path.join(os.tmpdir(), 'npm-dep-upgrade-tests'))
await mkdir(scratch, { recursive: true })
const root = path.join(scratch, 'runtimes'), versions = process.platform === 'win32' ? ['12.1.0'] : ['12.1.0', '11.10.0']
const variables = { NPM_DEP_FLOW_TEST_TMPDIR: scratch, NPM_DEP_PATHS_TEST_TMPDIR: scratch, TMPDIR: scratch }
for (const version of versions) {
  const prefix = path.join(root, 'npm-' + version)
  await mkdir(prefix, { recursive: true })
  const r = crossSpawn.sync('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', 'npm@' + version], { stdio: 'inherit' })
  if (r.status !== 0) throw r.error || new Error(`Cannot provision npm${version}`)
  const entry = path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  variables[version === '12.1.0' ? 'NPM_DEP_UPGRADE_E2E_NPM_CLI' : 'NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI'] = entry
}
const bin = path.join(root, 'bin')
await mkdir(bin, { recursive: true })
const entry = variables.NPM_DEP_UPGRADE_E2E_NPM_CLI
await writeFile(path.join(bin, 'npm'), `#!/bin/sh\nexec '${process.execPath.replaceAll('\'', '\'\\\'\'')}' '${entry.replaceAll('\'', '\'\\\'\'')}' "$@"\n`, { mode: 0o755 })
await writeFile(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
const toolsRoot = fileURLToPath(new URL('../../../../', import.meta.url))
for (const name of ['npm-dep-paths', 'npm-dep-audit', 'npm-dep-versions', 'npm-dep-upgrade-plan', 'npm-dep-upgrade']) {
  const cli = path.join(toolsRoot, name, 'bin', name + '.js')
  await writeFile(path.join(bin, name), `#!/bin/sh\nexec '${process.execPath.replaceAll('\'', '\'\\\'\'')}' '${cli.replaceAll('\'', '\'\\\'\'')}' "$@"\n`, { mode: 0o755 })
  await writeFile(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`)
}
if (!process.env.GITHUB_ENV || !process.env.GITHUB_PATH) throw new Error('CI provisioning requires GITHUB_ENV/GITHUB_PATH')
await appendFile(process.env.GITHUB_ENV, Object.entries(variables).map(([k, v]) => `${k}=${v}\n`).join(''))
await appendFile(process.env.GITHUB_PATH, bin + '\n')
