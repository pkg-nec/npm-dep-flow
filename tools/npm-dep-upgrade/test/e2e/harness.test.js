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
test('harness explicit phases, fixture integrity and unknown-request refusal',async t=>{
 const {createHash}=await import('node:crypto'),{tarball}=await import('./helpers/tarballs.js'),{leaf}=await import('./fixtures/catalog.js')
 const archive=tarball(leaf('e2e-test','1.0.0'))
 assert.equal(archive.integrity,'sha512-'+createHash('sha512').update(archive.bytes).digest('base64'))
 const f=await createProject(direct(),{},t)
 assert.ok(f.root.startsWith(f.scratch));assert.notEqual(f.env.npm_config_cache,process.env.npm_config_cache)
 const bad=await fetch(f.registry.url+'/unknown');assert.equal(bad.status,404);assert.equal(f.registry.unexpected.length,1)
 f.registry.setPhase('snapshot');await fetch(f.registry.url+'/e2e-target');assert.equal(f.registry.calls.at(-1).phase,'snapshot')
})
