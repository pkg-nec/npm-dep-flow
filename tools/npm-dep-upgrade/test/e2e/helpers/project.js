import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { startRegistry } from './registry.js'
import { createCommandPath, checked } from './commands.js'
export const scratchRoot = process.env.NPM_DEP_FLOW_TEST_TMPDIR || process.env.TMPDIR || '/home/maw/src/nrc/npm-dep-flow-impl/tmp'
export async function createProject(scenario, runtime, t) {
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(path.join(scratchRoot, 'e2e-upgrade-'))
  const registry = await startRegistry(scenario)
  const f = { scratch, registry, scenario, cleanup: async () => {
    await registry.close()
    await rm(scratch, { recursive: true, force: true })
  } }
  t?.after(f.cleanup)
  try {
    Object.assign(f, await createCommandPath({ ...runtime, scratch, registry: registry.url }))
    f.repoRoot = path.join(scratch, 'project space & dollar $')
    f.root = runtime.nested ? path.join(f.repoRoot, 'nested app') : f.repoRoot
    await mkdir(f.root, { recursive: true })
    await writeFile(path.join(f.repoRoot, '.gitignore'), 'node_modules/\n.npmrc\n')
    await writeFile(path.join(f.root, 'package.json'), JSON.stringify(scenario.manifest, null, 2) + '\n')
    await writeFile(path.join(f.root, '.npmrc'), `registry=${registry.url}\nmin-release-age=7\naudit=false\nfund=false\n`)
    await checked(f, 'npm', ['install', '--ignore-scripts', '--no-audit', `--lockfile-version=${runtime.lockfileVersion || 3}`])
    await checked(f, 'git', ['init', '-b', 'fixture'], f.repoRoot)
    await checked(f, 'git', ['config', 'user.name', 'Fixture'], f.repoRoot)
    await checked(f, 'git', ['config', 'user.email', 'fixture@example.invalid'], f.repoRoot)
    await mkdir(path.join(scratch, 'hooks'))
    await checked(f, 'git', ['config', 'core.hooksPath', path.join(scratch, 'hooks')], f.repoRoot)
    await checked(f, 'git', ['add', '.'], f.repoRoot)
    await checked(f, 'git', ['commit', '-m', 'test: seed dependency fixture'], f.repoRoot)
    f.initialHead = await checked(f, 'git', ['rev-parse', 'HEAD'])
    f.initialFiles = Object.fromEntries(await Promise.all(['package.json', 'package-lock.json'].map(async name => [name, await readFile(path.join(f.root, name))])))
    if (runtime.installed === false) await rm(path.join(f.root, 'node_modules'), { recursive: true, force: true })
    registry.setPhase('apply')
    // npm's metadata cache from seed must not hide the full deterministic catalog.
    await rm(path.join(scratch, 'npm-cache'), { recursive: true, force: true })
    return f
  }
  catch (error) {
    if (!t) await f.cleanup()
    throw error
  }
}
