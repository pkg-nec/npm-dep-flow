import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject } from './helpers/project.js'
import { direct } from './fixtures/catalog.js'
import { plan,runUpgrade,assertSuccess } from './helpers/runner.js'
test('harness D01 real registry, npm, audit, planner, Git and clean reproduction',async t=>{
 const f=await createProject(direct(),{},t)
 assert.match(f.npmVersion,/^12\.1\.0$/)
 const rows=await plan(f)
 assert.equal(rows.length,1)
 const result=await runUpgrade(f,[rows[0].id.slice(0,7),'--format','json'])
 await assertSuccess(f,result,'6.0.12',{reproduce:true})
 assert.ok(f.registry.calls.some(c=>c.path.includes('/-/npm/v1/security/advisories/bulk')))
 assert.ok(f.registry.calls.some(c=>c.path.includes('.tgz')))
 assert.deepEqual(f.registry.unexpected,[])
})
