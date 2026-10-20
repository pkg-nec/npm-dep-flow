import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { readCandidateAdvisories, normalizeTimestamp } from '../src/registry.js'
test('candidate security adapter includes candidate-only ranges and rejects bad service data', async()=>{
 const context={registry:'https://registry.example/',auditRegistry:'https://audit.example/',requestOptions:{}}
 const versions=new Map([['e2e-target',['6.0.10','6.0.12']]])
 const fetch=async(url,options)=>{
   assert.equal(url,'/-/npm/v1/security/advisories/bulk')
   assert.equal(options.registry,context.auditRegistry)
   assert.deepEqual(options.body,{'e2e-target':['6.0.10','6.0.12']})
   return {body:Readable.from([JSON.stringify({'e2e-target':[{id:1,name:'e2e-target',vulnerable_versions:'6.0.12'}]})])}
 }
 const result=await readCandidateAdvisories(versions,context,fetch)
 assert.equal(result.get('e2e-target')[0].range,'6.0.12')
 await assert.rejects(readCandidateAdvisories(versions,context,async()=>({body:Readable.from(['{"e2e-target":"bad"}'])})),/security|advisory/i)
 assert.equal(normalizeTimestamp('2026-02-31T00:00:00Z'),null)
})

test('catalog accepts npm 12 singleton-array time output',async()=>{
 const {readCatalog}=await import('../src/registry.js')
 const result=await readCatalog('/project','e2e-target',{minAgeDays:7},async(cmd,args)=>({code:0,stdout:JSON.stringify(args[2]==='versions'?['6.0.12']:[{'6.0.12':'2026-01-01T00:00:00Z'}])}))
 assert.equal(result.releaseTimes.get('6.0.12'),'2026-01-01T00:00:00.000Z')
})
