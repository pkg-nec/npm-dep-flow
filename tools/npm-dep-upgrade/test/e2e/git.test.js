import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {readFile,writeFile,rm} from 'node:fs/promises'
import {createProject} from './helpers/project.js'
import {direct,transitive} from './fixtures/catalog.js'
import {plan,runUpgrade,assertSuccess,assertUnchanged} from './helpers/runner.js'
import {checked,installCheckpoints} from './helpers/commands.js'
for(const trans of [false,true]) test(`G02 G03 ${trans?'transitive':'direct'} nested project preserves unrelated work`,async t=>{
 const f=await createProject(trans?transitive():direct(),{nested:true},t)
 await writeFile(path.join(f.repoRoot,'notes.txt'),'baseline\n');await checked(f,'git',['add','notes.txt'],f.repoRoot);await checked(f,'git',['commit','-m','test: track notes'],f.repoRoot)
 f.initialHead=await checked(f,'git',['rev-parse','HEAD'])
 await writeFile(path.join(f.repoRoot,'notes.txt'),'user work\n');await writeFile(path.join(f.repoRoot,'untracked.txt'),'untracked\n')
 const [row]=await plan(f);await assertSuccess(f,await runUpgrade(f,[row.id,'--format','json']))
 assert.equal(await readFile(path.join(f.repoRoot,'notes.txt'),'utf8'),'user work\n');assert.equal(await readFile(path.join(f.repoRoot,'untracked.txt'),'utf8'),'untracked\n')
 assert.equal(await checked(f,'git',['diff','--cached','--name-only']),'')
})
for(const variant of ['manifest unstaged','lock unstaged','manifest staged','lock staged','unrelated staged','untracked lock','missing lock']) test(`G01 F03 ${variant} refuses before install`,async t=>{
 const f=await createProject(direct(),{},t),[row]=await plan(f)
 if(variant.includes('manifest')) await writeFile(path.join(f.root,'package.json'),f.initialFiles['package.json'].toString()+' ')
 else if(variant.includes('lock')&&!variant.startsWith('untracked')&&!variant.startsWith('missing')) await writeFile(path.join(f.root,'package-lock.json'),f.initialFiles['package-lock.json'].toString()+' ')
 if(variant==='unrelated staged') {await writeFile(path.join(f.root,'other.txt'),'staged');await checked(f,'git',['add','other.txt'])}
 else if(variant.includes('staged')&&!variant.includes('unstaged')) await checked(f,'git',['add',variant.startsWith('manifest')?'package.json':'package-lock.json'])
 if(variant==='untracked lock') {await checked(f,'git',['rm','--cached','package-lock.json']);await checked(f,'git',['commit','-m','test: untrack lock'])}
 if(variant==='missing lock') await rm(path.join(f.root,'package-lock.json'))
 const head=await checked(f,'git',['rev-parse','HEAD']),index=await checked(f,'git',['diff','--cached','--binary'])
 const before={};for(const file of ['package.json','package-lock.json']) {try{before[file]=await readFile(path.join(f.root,file))}catch{
  // The missing-lockfile variant intentionally has no bytes to snapshot.
 }}
 const result=await runUpgrade(f,[row.id]);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/git|tracked|staging|clean/i)
 assert.equal(await checked(f,'git',['rev-parse','HEAD']),head);assert.equal(await checked(f,'git',['diff','--cached','--binary']),index)
 for(const [file,bytes] of Object.entries(before)) assert.deepEqual(await readFile(path.join(f.root,file)),bytes)
 assert.equal(f.registry.calls.filter(c=>c.path.startsWith('/tarballs/')&&c.phase!=='seed').length,0)
})
for(const variant of ['identity','detached','operation']) test(`G06 Git ${variant} precondition`,async t=>{
 const f=await createProject(direct(),{},t),[row]=await plan(f)
 if(variant==='identity') {await checked(f,'git',['config','--unset','user.name']);await checked(f,'git',['config','--unset','user.email']);await checked(f,'git',['config','user.useConfigOnly','true'])}
 if(variant==='detached') await checked(f,'git',['checkout','--detach'])
 if(variant==='operation') await writeFile(path.join(f.root,'.git','MERGE_HEAD'),f.initialHead+'\n')
 await assertUnchanged(f,await runUpgrade(f,[row.id]),/identity|branch|operation/i)
})
test('G06 rejecting commit hook retains verified changes and clears owned staging',async t=>{
 const f=await createProject(direct(),{},t),[row]=await plan(f)
 await writeFile(path.join(f.scratch,'hooks','pre-commit'),'#!/bin/sh\nexit 42\n',{mode:0o755})
 const result=await runUpgrade(f,[row.id]);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/commit.*uncommitted/i)
 assert.equal(await checked(f,'git',['rev-parse','HEAD']),f.initialHead)
 assert.equal(await checked(f,'git',['diff','--cached','--name-only']),'')
 assert.equal(JSON.parse(await readFile(path.join(f.root,'package.json'))).dependencies['e2e-target'],'^6.0.12')
})
for(const variant of ['user edit','staged file','HEAD movement']) test(`G07 concurrent ${variant} at explicit checkpoint`,async t=>{
 const s=transitive(),f=await createProject(s,{},t),[row]=await plan(f)
 let movedHead
 s.checkpoint=async({stage,count})=>{
  if(stage!=='after'||count!==2) return
  if(variant==='user edit') await writeFile(path.join(f.root,'package.json'),'{"user":"concurrent"}\n')
  if(variant==='staged file') {await writeFile(path.join(f.root,'user.txt'),'concurrent');await checked(f,'git',['add','user.txt'])}
  if(variant==='HEAD movement') {await checked(f,'git',['commit','--allow-empty','-m','test: concurrent commit']);movedHead=await checked(f,'git',['rev-parse','HEAD'])}
 }
 await installCheckpoints(f)
 const result=await runUpgrade(f,[row.id]);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.match(result.stderr,/changed|recovery|outside|head|staging/i)
 if(variant==='user edit') assert.equal(await readFile(path.join(f.root,'package.json'),'utf8'),'{"user":"concurrent"}\n')
 if(variant==='staged file') assert.equal(await checked(f,'git',['diff','--cached','--name-only']),'user.txt')
 assert.equal(await checked(f,'git',['rev-parse','HEAD']),movedHead||f.initialHead)
})
