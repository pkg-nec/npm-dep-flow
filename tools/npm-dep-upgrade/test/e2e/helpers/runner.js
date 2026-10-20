import assert from 'node:assert/strict'
import { readFile,mkdir,writeFile,readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { command,checked } from './commands.js'
export async function plan(f,format='json') {
 const output=await checked(f,'npm-dep-upgrade-plan',['.','--format',format])
 return format==='json'?JSON.parse(output).rows:output
}
export const runUpgrade=(f,args)=>command(f,'npm-dep-upgrade',args)
export async function assertResolved(f,parentLocation,name,version,root=f.root) {
 const require=createRequire(path.join(root,parentLocation,'__resolve.cjs'))
 const manifest=JSON.parse(await readFile(require.resolve(name+'/package.json'),'utf8'))
 assert.equal(manifest.name,name);assert.equal(manifest.version,version)
}
export async function assertUnchanged(f,result,pattern) {
 assert.equal(result.code,1,result.stdout);assert.equal(result.stdout,'');if(pattern) assert.match(result.stderr,pattern)
 assert.equal(await checked(f,'git',['rev-parse','HEAD']),f.initialHead)
 for(const [name,bytes] of Object.entries(f.initialFiles)) assert.deepEqual(await readFile(path.join(f.root,name)),bytes,`${name} changed`)
 assert.equal(await checked(f,'git',['diff','--cached','--name-only']),'')
}
async function noScripts(root) {
 for(const entry of await readdir(root,{withFileTypes:true})) {assert.notEqual(entry.name,'SCRIPT_RAN');if(entry.isDirectory()&&entry.name!=='.git') await noScripts(path.join(root,entry.name))}
}
export async function assertSuccess(f,result,version='6.0.12',{reproduce=false,location,name}={}) {
 assert.equal(result.code,0,result.stderr)
 const output=JSON.parse(result.stdout);name??=output.package;location??=output.targetLocation
 assert.equal(output.package,name);assert.equal(output.newVersion,version);assert.equal(output.targetLocation,location)
 assert.equal(await checked(f,'git',['rev-list','--count',`${f.initialHead}..HEAD`]),'1')
 assert.equal(await checked(f,'git',['log','-1','--format=%s']),`deps: bump ${name} from 6.0.9 to ${version}`)
 assert.equal(await checked(f,'git',['rev-parse','HEAD']),output.commit.hash)
 const files=(await checked(f,'git',['diff-tree','--no-commit-id','--name-only','-r','HEAD'])).split('\n').map(p=>p.replace(/^nested app\//,''))
 assert.deepEqual(files.sort(),[...output.changedFiles].map(p=>p.replace(/^nested app\//,'')).sort())
 assert.ok(files.every(p=>['package.json','package-lock.json'].includes(p)))
 for(const file of files) assert.equal(await checked(f,'git',['show',`HEAD:${f.root===f.repoRoot?'':'nested app/'}${file}`]),(await readFile(path.join(f.root,file),'utf8')).trim())
 await assertResolved(f,path.posix.dirname(location).replace(/(?:^|\/)node_modules$/,''),name,version)
 await noScripts(f.root)
 if(reproduce) {
  const copy=path.join(f.scratch,'clean ci');await mkdir(copy)
  for(const file of ['package.json','package-lock.json','.npmrc']) await writeFile(path.join(copy,file),await readFile(path.join(f.root,file)))
  await checked(f,'npm',['ci','--ignore-scripts','--no-audit'],copy)
  await assertResolved(f,path.posix.dirname(location).replace(/(?:^|\/)node_modules$/,''),name,version,copy)
  await noScripts(copy)
 }
 return output
}
