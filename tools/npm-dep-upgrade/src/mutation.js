import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertGitState } from './git.js'
import { recordOwnedFiles } from './recovery.js'
import { fail } from './errors.js'
import { createScopeProbe, planScopes } from './scopes.js'
function serialize(value,original) {
 const source=original.toString('utf8')
 const indent=/\n([\t ]+)"/.exec(source)?.[1]
 const newline=source.includes('\r\n') ? '\r\n' : '\n'
 let text=JSON.stringify(value,null,indent)
 if(newline==='\r\n') text=text.replaceAll('\n','\r\n')
 return Buffer.from(text+(source.endsWith('\n')?newline:''))
}
export async function buildMutation(project,evidence,candidate,deps={}) {
 const manifest=structuredClone(project.manifest)
 if(evidence.directDeclarations.length) {
   for(const d of evidence.directDeclarations) {
     if(!/^[~^]\s*\d+\.\d+\.\d+(?:[+-][\w.+-]+)?\s*$/.test(d.spec)) fail('UNSUPPORTED_REQUIREMENT','mutation','Only caret/tilde direct declarations are supported')
     manifest[d.field][d.requestedName]=d.spec.trim()[0]+candidate.version
   }
   const cleanupBytes=serialize(manifest,project.manifestBytes)
   // npm's age filter admits absent timestamps. Resolve exactly what we checked,
   // then restore the user's range and prove that the lock retains this version.
   for(const d of evidence.directDeclarations) manifest[d.field][d.requestedName]=candidate.version
   return {kind:'direct',applyBytes:serialize(manifest,project.manifestBytes),cleanupBytes,scopedLocations:[evidence.item.targetLocation]}
 }
 const probeScope=deps.probeScope || await createScopeProbe(project,deps.scratchRoot)
 const scope=await planScopes(project,evidence,candidate,{probeScope})
 manifest.overrides=scope.overrides
 return {kind:'transitive',applyBytes:serialize(manifest,project.manifestBytes),cleanupBytes:project.manifestBytes,scopedLocations:scope.scopedLocations}
}
export async function writeMutation(root,bytes,guard) {
 await assertGitState(guard,'before-write')
 await writeFile(path.join(root,'package.json'),bytes)
 await recordOwnedFiles(guard,{'package.json':bytes})
}
