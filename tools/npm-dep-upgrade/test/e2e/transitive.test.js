import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {createProject} from './helpers/project.js'
import {transitive,shared,separate,ancestor,sharedAncestry,parentVersions,repeated,existingOverride} from './fixtures/catalog.js'
import {plan,runUpgrade,assertSuccess,assertResolved,assertUnchanged} from './helpers/runner.js'
export async function apply(t,s,runtime={}) {
 const f=await createProject(s,runtime,t),rows=await plan(f),row=rows.find(r=>r.status==='eligible')
 assert.ok(row,JSON.stringify(rows))
 const result=await runUpgrade(f,[row.id,'--format','json'])
 await assertSuccess(f,result)
 assert.deepEqual(await readFile(path.join(f.root,'package.json')),f.initialFiles['package.json'])
 return f
}
for(const field of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) for(const op of ['^','~']) test(`T01 ${field} child ${op}`,async t=>{
 const f=await apply(t,transitive(field,op));await assertResolved(f,'','e2e-parent-a','1.2.4')
})
test('T02 transitive parent',async t=>{await apply(t,ancestor())})
test('T09 shared ancestry with 2048 routes upgrades without expanding every route',async t=>{
 const f=await apply(t,sharedAncestry())
 await assertResolved(f,'node_modules/e2e-parent-a','e2e-target','6.0.12')
})
test('T03 distinct parent versions',async t=>{
 const f=await apply(t,parentVersions());await assertResolved(f,'node_modules/e2e-ancestor-b/node_modules/e2e-parent-a','e2e-target','7.0.5')
})
test('T04 repeated parent versions narrow ancestry or safely refuse',async t=>{
 const f=await createProject(repeated(),{},t),rows=await plan(f)
 assert.equal(rows.length,2,JSON.stringify(rows));assert.equal(rows.filter(r=>r.status==='eligible').length,1)
 const row=rows.find(r=>r.status==='eligible'),r=await runUpgrade(f,[row.id,'--format','json'])
 if(r.code) await assertUnchanged(f,r,/scope|unsupported/i)
 else {await assertSuccess(f,r);await assertResolved(f,'node_modules/e2e-ancestor-b/node_modules/e2e-parent-a','e2e-target','6.0.9')}
})
test('T05 shared caret and tilde target preserves all incoming consumers',async t=>{
 const f=await apply(t,shared());await assertResolved(f,'node_modules/e2e-parent-a','e2e-target','6.0.12');await assertResolved(f,'node_modules/e2e-parent-b','e2e-target','6.0.12')
})
test('T07 separate eligible and pinned target copies',async t=>{
 const f=await createProject(separate(),{},t),rows=await plan(f)
 assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.status==='eligible').length,1)
 await assertResolved(f,'node_modules/e2e-parent-a','e2e-target','6.0.9');await assertResolved(f,'node_modules/e2e-parent-b','e2e-target','6.0.9')
 await assertSuccess(f,await runUpgrade(f,[rows.find(r=>r.status==='eligible').id,'--format','json']),undefined,{reproduce:true})
 await assertResolved(f,'','e2e-target','7.0.5');await assertResolved(f,'node_modules/e2e-parent-b','e2e-target','6.0.9')
 assert.equal((await plan(f)).filter(r=>r.package==='e2e-target').length,1)
})
test('O01 existing override policy and bytes survive cleanup',async t=>{await apply(t,existingOverride())})
test('R06 scoped parent and target',async t=>{await apply(t,transitive('dependencies','^',{parent:'@e2e/parent',target:'@e2e/target'}))})
