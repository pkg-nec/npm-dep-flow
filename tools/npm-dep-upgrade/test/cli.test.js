import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/cli.js'
const capture=()=>{let stdout='',stderr='';return {io:{stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}},out:()=>stdout,err:()=>stderr}}
test('help/version bypass project mutation and argument failures emit no success report',async()=>{
 const c=capture()
 assert.equal(await main(['--help'],c.io),0)
 assert.match(c.out(),/npm-dep-upgrade.*id/i)
 const bad=capture()
 assert.equal(await main(['--to','6.0.12'],bad.io),1)
 assert.equal(bad.out(),'')
 assert.match(bad.err(),/arguments/i)
})
test('failed planner precondition never emits success or commits',async()=>{
 const c=capture(),calls=[]
 const deps={preflightGit:async()=>{calls.push('git');throw new Error('dirty dependency files')}}
 assert.equal(await main(['abcdef0'],c.io,deps),1)
 assert.deepEqual(calls,['git'])
 assert.equal(c.out(),'')
 assert.match(c.err(),/dirty/)
})
test('direct transaction verifies then commits before emitting a completed result',async t=>{
 const {gitProject}=await import('./helpers/git-project.js')
 const {preflightGit}=await import('../src/git.js')
 const {loadProject}=await import('../src/project.js'),{loadGraph}=await import('../src/graph.js')
 const {itemId}=await import('../src/planner.js')
 const {readFile,writeFile,mkdir}=await import('node:fs/promises'),path=await import('node:path')
 const f=await gitProject(t),guard=await preflightGit(f.root),project=await loadProject(f.root),graph=await loadGraph(f.root),events=[]
 const item={id:itemId('e2e-target','node_modules/e2e-target'),package:'e2e-target',version:'6.0.9',targetLocation:'node_modules/e2e-target',minimumSafeVersion:'6.0.10',status:'eligible',strategy:{id:'update-within-declared-range'}}
 const evidence={item,graph,auditRows:[],incoming:graph.edges,directDeclarations:[{field:'dependencies',requestedName:'e2e-target',spec:'^6.0.8'}],upstream:[]}
 const c=capture()
 const deps={preflightGit:async()=>guard,readPlanner:async()=>{events.push('plan');return {rows:[item]}},readEvidence:async()=>evidence,loadNpmContext:async()=>({minAgeDays:7,installArgs:['install','--ignore-scripts','--min-release-age=7']}),readCatalog:async()=>({versions:['6.0.12'],releaseTimes:new Map([['6.0.12','2026-01-01T00:00:00Z']])}),readCandidateAdvisories:async()=>new Map(),installProject:async installRoot=>{
   events.push('install')
   const manifest=JSON.parse(await readFile(path.join(installRoot,'package.json')))
   const lock=structuredClone(f.lock);lock.packages['']=manifest;lock.packages['node_modules/e2e-target'].version='6.0.12'
   await writeFile(path.join(installRoot,'package-lock.json'),JSON.stringify(lock))
   await mkdir(path.join(installRoot,'node_modules','e2e-target'),{recursive:true})
   await writeFile(path.join(installRoot,'node_modules','e2e-target','package.json'),JSON.stringify({name:'e2e-target',version:'6.0.12'}))
 },verifyFinalSecurity:async()=>{assert.equal(c.out(),'');events.push('security')}}
 assert.equal(await main([item.id,'--format','json'],c.io,deps),0,c.err())
 const result=JSON.parse(c.out())
 assert.equal(result.newVersion,'6.0.12')
 assert.match(result.commit.hash,/^[a-f0-9]{40,64}$/)
 assert.deepEqual(events,['plan','install','install','install','security'])
})
