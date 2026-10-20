import Config from '@npmcli/config'
import configDefinitions from '@npmcli/config/lib/definitions/index.js'
import { readFile, realpath, access } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './process.js'
import { fail } from './errors.js'
export async function resolveNpmPath(env = process.env) {
  const candidates = []
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.cmd','.exe',''] : ['']) {
      const command = path.join(directory, `npm${suffix}`)
      try {
        await access(command)
        const actual = await realpath(command)
        candidates.push(path.dirname(path.dirname(actual)), path.join(path.dirname(actual),'node_modules','npm'))
        const source = await readFile(actual,'utf8')
        for (const match of source.matchAll(/["']([^"'\r\n]*npm-cli\.js)["']/g)) candidates.push(path.dirname(path.dirname(match[1].replace(/%~dp0/gi,path.dirname(actual)+path.sep))))
        for (const root of candidates) {
          try { const p=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')); if(p.name==='npm') return root } catch {}
        }
        break
      } catch {}
    }
  }
  fail('NPM_CONTEXT','configuration','Cannot resolve the selected npm package and builtin configuration')
}
export async function loadNpmContext(projectRoot, deps = {}) {
  const run = deps.run || runProcess
  const env = deps.env || process.env
  const npmPath = deps.npmPath || await resolveNpmPath(env)
  const versionResult = await run('npm',['--version'],{cwd:projectRoot,env})
  const version = versionResult.stdout.trim()
  const metadata = JSON.parse(await readFile(path.join(npmPath,'package.json'),'utf8'))
  if (versionResult.code || version !== metadata.version) fail('NPM_CONTEXT','configuration','Selected npm version/configuration mismatch')
  const {definitions,shorthands,flatten}=configDefinitions
  const config = new Config({npmPath,definitions,shorthands,flatten,cwd:projectRoot,env,argv:[]})
  try { await config.load(); config.validate(); if(!config.valid) throw new Error('invalid') }
  catch { fail('NPM_CONTEXT','configuration','Cannot load valid effective npm configuration') }
  const registry=config.get('registry'), auditRegistry=config.get('audit-registry') || registry
  const minAgeDays=Math.max(7,Number(config.get('min-release-age') || 0))
  const before=config.get('before')
  const cutoffMs=before ? Date.parse(before) : null
  if (!Number.isFinite(minAgeDays) || (before && !Number.isFinite(cutoffMs))) fail('NPM_CONTEXT','configuration','Invalid release-age policy')
  const installArgs=['install','--ignore-scripts',`--min-release-age=${minAgeDays}`,'--no-audit','--no-fund']
  if(before) installArgs.push(`--before=${new Date(cutoffMs).toISOString()}`)
  const stagingPathArgs=Object.entries(definitions).filter(([key,definition])=>definition.type===path && key!=='prefix' && !definition.deprecated).flatMap(([key])=>{
    const value=config.get(key)
    return typeof value==='string'&&value ? [`--${key}=${value}`] : []
  })
  return {version,registry,auditRegistry,stagingPathArgs,requestOptions:{...config.flat},installArgs,minAgeDays,cutoffMs}
}
