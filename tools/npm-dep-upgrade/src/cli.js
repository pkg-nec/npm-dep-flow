import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseArgs } from './args.js'
import { preflightGit,assertGitState,readDependencyFiles,commitUpgrade } from './git.js'
import { recordOwnedFiles,restoreDependencyFiles } from './recovery.js'
import { loadProject } from './project.js'
import { loadGraph } from './graph.js'
import { readPlanner,selectItem } from './planner.js'
import { readEvidence } from './evidence.js'
import { loadNpmContext } from './npm-context.js'
import { readCatalog,readCandidateAdvisories } from './registry.js'
import { selectCandidate } from './candidates.js'
import { buildMutation,writeMutation } from './mutation.js'
import { installProject } from './installer.js'
import { verifyGraph,verifyFinalSecurity } from './verify.js'
import { renderJson,renderMarkdown } from './report.js'
const toolRoot=fileURLToPath(new URL('../',import.meta.url))
const defaults={preflightGit,assertGitState,loadProject,loadGraph,readPlanner,readEvidence,loadNpmContext,readCatalog,readCandidateAdvisories,selectCandidate,buildMutation,writeMutation,installProject,verifyGraph,verifyFinalSecurity,commitUpgrade}
export async function main(argv,io=process,overrides={}) {
 const d={...defaults,...overrides}
 let guard,mutated=false,committing=false,stage='arguments'
 try {
  const options=parseArgs(argv)
  if(options.action!=='upgrade') {
   const pkg=JSON.parse(await readFile(path.join(toolRoot,'package.json'),'utf8'))
   io.stdout.write(options.action==='version'?`${pkg.name} v${pkg.version}\nLocation: ${toolRoot}\n`:`${pkg.name} v${pkg.version}\n\nUsage: npm-dep-upgrade <id-or-prefix> [--package <name>] [--format markdown|json]\n\nUpgrade one eligible planner installation in the current directory and commit the verified dependency files.\n`)
   return 0
  }
  stage='preflight';guard=await d.preflightGit(process.cwd())
  const project=await d.loadProject(guard.root)
  stage='planner';const item=selectItem(await d.readPlanner(project.root),options.selector,options.packageName)
  stage='evidence';const evidence=await d.readEvidence(project,item)
  stage='configuration';const context=await d.loadNpmContext(project.root);context.projectRoot=project.root
  stage='selection';const catalog=await d.readCatalog(project.root,item.package,context)
  const advisoryMap=await d.readCandidateAdvisories(new Map([[item.package,catalog.versions]]),context)
  const candidate=d.selectCandidate(item,evidence.incoming.map(e=>e.rawSpec),catalog,advisoryMap.get(item.package)||[],Date.now())
  stage='scope';const mutation=await d.buildMutation(project,evidence,candidate)
  await d.assertGitState(guard,'before-write')
  const installPhase=async phase=>{
    guard.installedTreeMayHaveChanged=true
    let installationError
    try {await d.installProject(project.root,context,{stderr:io.stderr})} catch(error) {installationError=error}
    const files=await readDependencyFiles(project.root)
    if(!files['package.json'].equals(guard.ownedFiles['package.json'])) throw new Error('package.json changed outside the expected mutation')
    if(!files['package-lock.json'].equals(guard.ownedFiles['package-lock.json'])) {
      // Only adopt an npm result whose semantic changes fit this operation's scope.
      const graph=await d.loadGraph(project.root)
      const observed=graph.nodes.get(item.targetLocation)
      if(observed?.name===item.package) {
        d.verifyGraph(evidence.graph,graph,evidence,{...candidate,version:observed.version},mutation,phase)
        await recordOwnedFiles(guard,{'package-lock.json':files['package-lock.json']})
      }
    }
    if(installationError) throw installationError
    await d.loadProject(project.root)
    return d.verifyGraph(evidence.graph,await d.loadGraph(project.root),evidence,candidate,mutation,phase)
  }
  stage='apply';await d.writeMutation(project.root,mutation.applyBytes,guard);mutated=true
  stage='install';let diff=await installPhase('installed')
  if(mutation.cleanupBytes) {
    stage='cleanup';await d.writeMutation(project.root,mutation.cleanupBytes,guard)
    diff=await installPhase('cleaned')
  }
  stage='verification';await d.verifyFinalSecurity(evidence,candidate,diff,context)
  const actual=await d.loadGraph(project.root,{actual:true})
  const target=actual.nodes.get(item.targetLocation)
  if(!target || target.name!==item.package || target.version!==candidate.version) throw new Error('Installed target does not match the verified lockfile')
  await d.assertGitState(guard,'before-commit')
  stage='commit';committing=true
  const committed=await d.commitUpgrade(guard,guard.ownedFiles,{package:item.package,oldVersion:item.version,newVersion:candidate.version})
  const result={schemaVersion:2,id:item.id,package:item.package,oldVersion:item.version,newVersion:candidate.version,targetLocation:item.targetLocation,strategy:'update-within-declared-range',releasedAt:candidate.releasedAt,changedFiles:committed.changedFiles,supportingChanges:diff.supportingChanges,commit:{hash:committed.hash,subject:committed.subject}}
  io.stdout.write(options.format==='json'?renderJson(result):renderMarkdown(result))
  return 0
 } catch(error) {
  let recovery=''
  if(mutated && !committing) {
    try {const result=await restoreDependencyFiles(guard);recovery=` Dependency files restored.${result.installedTreeMayHaveChanged?' node_modules may have changed.':''}`}
    catch(e) {recovery=` Recovery could not restore dependency files: ${e.message}. node_modules may have changed.`}
  } else if(committing) recovery=' Verified dependency changes may remain uncommitted; inspect Git state.'
  io.stderr.write(`npm-dep-upgrade: ${error.stage || stage}: ${error.message}${recovery}\n`)
  return 1
 }
}
