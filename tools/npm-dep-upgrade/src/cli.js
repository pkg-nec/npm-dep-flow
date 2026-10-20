import {readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {parseArgs} from './args.js'
import {preflightGit,assertGitState,readDependencyFiles,commitUpgrade} from './git.js'
import {recordOwnedFiles,restoreDependencyFiles} from './recovery.js'
import {loadProject} from './project.js'
import {loadGraph} from './graph.js'
import {readPlanner,selectItem} from './planner.js'
import {readEvidence} from './evidence.js'
import {loadNpmContext} from './npm-context.js'
import {readCatalog,readCandidateAdvisories} from './registry.js'
import {selectCandidate} from './candidates.js'
import {buildMutation,writeMutation} from './mutation.js'
import {installProject} from './installer.js'
import {createStagingProject} from './staging.js'
import {verifyGraph,verifyFinalSecurity} from './verify.js'
import {renderJson,renderMarkdown} from './report.js'
const toolRoot=fileURLToPath(new URL('../',import.meta.url))
const defaults={preflightGit,assertGitState,loadProject,loadGraph,readPlanner,readEvidence,loadNpmContext,readCatalog,readCandidateAdvisories,selectCandidate,buildMutation,writeMutation,installProject,createStagingProject,verifyGraph,verifyFinalSecurity,commitUpgrade}
export async function main(argv,io=process,overrides={}) {
  const d={...defaults,...overrides}
  let guard,staging,mutated=false,committing=false,stage='arguments'
  try {
    const options=parseArgs(argv)
    if(options.action!=='upgrade') {
      const pkg=JSON.parse(await readFile(path.join(toolRoot,'package.json'),'utf8'))
      io.stdout.write(options.action==='version'?`${pkg.name} v${pkg.version}\nLocation: ${toolRoot}\n`:`${pkg.name} v${pkg.version}\n\nUsage: npm-dep-upgrade [project] <id-or-prefix> [--package <name>] [--format markdown|json]\n\nArguments:\n  project         Project directory (default: ., the caller's current directory)\n  id-or-prefix    Required planner item ID or unique prefix\n\nUpgrade one eligible planner installation in the selected project and commit the verified dependency files.\n`)
      return 0
    }
    stage='preflight';guard=await d.preflightGit(options.projectPath)
    const project=await d.loadProject(guard.root)
    stage='planner';const item=selectItem(await d.readPlanner(project.root),options.selector,options.packageName)
    stage='evidence';const evidence=await d.readEvidence(project,item)
    stage='configuration';const context=await d.loadNpmContext(project.root);context.projectRoot=project.root
    stage='selection';const catalog=await d.readCatalog(project.root,item.package,context)
    const advisoryMap=await d.readCandidateAdvisories(new Map([[item.package,catalog.versions]]),context)
    const candidate=d.selectCandidate(item,evidence.incoming.map(e=>e.rawSpec),catalog,advisoryMap.get(item.package)||[],Date.now())
    stage='scope';const mutation=await d.buildMutation(project,evidence,candidate)
    await d.assertGitState(guard,'before-write')
    staging=await d.createStagingProject(project,context)
    const installPhase=async phase=>{
      await d.installProject(staging.root,staging.context,{stderr:io.stderr})
      const installedFiles=await readDependencyFiles(staging.root)
      const expectedManifest=phase==='installed'?mutation.applyBytes:mutation.cleanupBytes
      if(!installedFiles['package.json'].equals(expectedManifest)) throw new Error('npm changed package.json outside the intended mutation')
      await d.loadProject(staging.root)
      return d.verifyGraph(evidence.graph,await d.loadGraph(staging.root),evidence,candidate,mutation,phase)
    }
    stage='apply';await writeFile(path.join(staging.root,'package.json'),mutation.applyBytes)
    stage='install';let diff=await installPhase('installed')
    if(mutation.cleanupBytes) {
      stage='cleanup';await writeFile(path.join(staging.root,'package.json'),mutation.cleanupBytes)
      diff=await installPhase('cleaned')
    }
    const resultFiles=await readDependencyFiles(staging.root)
    // Publish only our private resolver output, after proving the real project
    // has no concurrent edits. Invalid staged results never touch user files.
    await d.assertGitState(guard,'before-publish')
    stage='publish';await d.writeMutation(project.root,resultFiles['package.json'],guard);mutated=true
    await d.assertGitState(guard,'before-lock-write')
    await writeFile(path.join(project.root,'package-lock.json'),resultFiles['package-lock.json'])
    await recordOwnedFiles(guard,{'package-lock.json':resultFiles['package-lock.json']})
    stage='install';guard.installedTreeMayHaveChanged=true
    await d.installProject(project.root,{...context,installArgs:['ci',...context.installArgs.slice(1)]},{stderr:io.stderr})
    await d.assertGitState(guard,'after-ci')
    stage='verification';await d.verifyFinalSecurity(evidence,candidate,diff,context)
    const actual=await d.loadGraph(project.root,{actual:true})
    const target=actual.nodes.get(item.targetLocation)
    if(!target||target.name!==item.package||target.version!==candidate.version) throw new Error('Installed target does not match the verified lockfile')
    await d.assertGitState(guard,'before-commit')
    stage='commit';committing=true
    const committed=await d.commitUpgrade(guard,guard.ownedFiles,{package:item.package,oldVersion:item.version,newVersion:candidate.version})
    const result={schemaVersion:2,id:item.id,package:item.package,oldVersion:item.version,newVersion:candidate.version,targetLocation:item.targetLocation,strategy:'update-within-declared-range',releasedAt:candidate.releasedAt,changedFiles:committed.changedFiles,supportingChanges:diff.supportingChanges,commit:{hash:committed.hash,subject:committed.subject}}
    io.stdout.write(options.format==='json'?renderJson(result):renderMarkdown(result))
    return 0
  } catch(error) {
    let recovery=''
    if(mutated&&!committing) {
      try {const result=await restoreDependencyFiles(guard);recovery=` Dependency files restored.${result.installedTreeMayHaveChanged?' node_modules may have changed.':''}`}
      catch(e) {recovery=` Recovery could not restore dependency files: ${e.message}. node_modules may have changed.`}
    } else if(committing) recovery=' Verified dependency changes may remain uncommitted; inspect Git state.'
    else if(staging) recovery=' Original dependency files were not changed by this operation.'
    io.stderr.write(`npm-dep-upgrade: ${error.stage||stage}: ${error.message}${recovery}\n`)
    return 1
  } finally {
    if(staging) await staging.cleanup().catch(()=>io.stderr.write('npm-dep-upgrade: could not remove private staging directory\n'))
  }
}
