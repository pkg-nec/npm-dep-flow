import { mkdir, writeFile, symlink, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../../../src/process.js'

export const toolsRoot = fileURLToPath(new URL('../../../../', import.meta.url))
export async function createCommandPath(runtime, toolRoots = toolsRoot) {
  const bin = path.join(runtime.scratch, 'bin')
  await mkdir(bin, { recursive: true })
  const npmCli = runtime.npmCli || process.env.NPM_DEP_UPGRADE_E2E_NPM_CLI || path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
  const entries = { npm: npmCli, ...Object.fromEntries(['npm-dep-paths', 'npm-dep-audit', 'npm-dep-versions', 'npm-dep-upgrade-plan', 'npm-dep-upgrade'].map(name => [name, path.join(toolRoots, name, 'bin', name + '.js')])) }
  for (const [name, file] of Object.entries(entries)) {
    if (process.platform === 'win32') await writeFile(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`)
    else await symlink(file, path.join(bin, name))
  }
  // Avoid developer npm configs/environment and Git identities, hooks and configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && !/^GIT_/i.test(key)))
  Object.assign(env, { PATH: bin + path.delimiter + process.env.PATH, HOME: runtime.scratch, USERPROFILE: runtime.scratch, TMPDIR: runtime.scratch, TMP: runtime.scratch, TEMP: runtime.scratch, XDG_CACHE_HOME: path.join(runtime.scratch, 'xdg'), NPM_DEP_FLOW_TEST_TMPDIR: runtime.scratch, NPM_DEP_PATHS_TEST_TMPDIR: runtime.scratch, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(runtime.scratch, 'gitconfig'), npm_config_userconfig: path.join(runtime.scratch, 'user.npmrc'), npm_config_globalconfig: path.join(runtime.scratch, 'global.npmrc'), npm_config_cache: path.join(runtime.scratch, 'npm-cache'), npm_config_registry: runtime.registry, npm_config_fetch_retries: '0', npm_config_update_notifier: 'false', npm_config_min_release_age: '7' })
  for (const file of ['gitconfig', 'user.npmrc', 'global.npmrc']) await writeFile(path.join(runtime.scratch, file), '')
  const npmVersion = JSON.parse(await readFile(path.resolve(npmCli, '../../package.json'), 'utf8')).version
  return { env, npmVersion, npmCli }
}
export async function command(f, cmd, args, root = f.root) {
  return runProcess(cmd, args, { cwd: root, env: f.env })
}
export async function checked(f, cmd, args, root = f.root) {
  const r = await command(f, cmd, args, root)
  if (r.code) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}\n${r.stdout}`)
  return r.stdout.trim()
}
export async function installCheckpoints(f) {
  const { unlink } = await import('node:fs/promises')
  const wrapper = path.join(f.scratch, 'npm-checkpoint.mjs')
  await writeFile(wrapper, `import {spawnSync} from 'node:child_process';import{readFileSync,writeFileSync}from'node:fs';
const npmCli=${JSON.stringify(f.npmCli)},args=process.argv.slice(2),file=${JSON.stringify(path.join(f.scratch, 'install-count'))};
let count=0;try{count=Number(readFileSync(file,'utf8'))}catch{}
const install=['install','ci'].includes(args[0]);if(install){count++;writeFileSync(file,String(count))}
async function checkpoint(stage){if(!install)return;const r=await fetch(${JSON.stringify(f.registry.url + '/__checkpoint')},{method:'POST',body:JSON.stringify({stage,count,args,cwd:process.cwd()})});const data=await r.json();if(data.exit)process.exit(data.exit)}
await checkpoint('before');const result=spawnSync(process.execPath,[npmCli,...args],{stdio:'inherit',env:process.env});await checkpoint('after');process.exit(result.status??1);
`)
  const bin = path.join(f.scratch, 'bin')
  if (process.platform === 'win32') await writeFile(path.join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${wrapper}" %*\r\n`)
  else {
    await unlink(path.join(bin, 'npm'))
    await writeFile(path.join(bin, 'npm'), `#!/bin/sh\nexec '${process.execPath.replaceAll('\'', '\'\\\'\'')}' '${wrapper.replaceAll('\'', '\'\\\'\'')}' "$@"\n`, { mode: 0o755 })
  }
  // Keep a quoted npm-cli.js reference in the launcher for effective builtin config discovery.
  if (process.platform === 'win32') await (await import('node:fs/promises')).appendFile(path.join(bin, 'npm.cmd'), `rem "${f.npmCli}"\r\n`)
  else await (await import('node:fs/promises')).appendFile(path.join(bin, 'npm'), `# "${f.npmCli}"\n`)
}
