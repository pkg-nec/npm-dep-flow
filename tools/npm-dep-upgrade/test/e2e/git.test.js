import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises'
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
