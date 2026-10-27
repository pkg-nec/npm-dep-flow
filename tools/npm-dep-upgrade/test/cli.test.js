import assert from 'node:assert/strict'
import test from 'node:test'
import { main } from '../src/cli.js'

const capture = () => {
  let stdout = '', stderr = ''
  const io = {
    stdout: {
      write: (s) => {
        stdout += s
      },
    },
    stderr: {
      write: (s) => {
        stderr += s
      },
    },
  }
  return { io, out: () => stdout, err: () => stderr }
}
test('help/version bypass project mutation and argument failures emit no success report', async () => {
  const c = capture()
  assert.equal(await main(['--help'], c.io), 0)
  assert.match(c.out(), /Usage: npm-dep-upgrade \[project\] <id-or-prefix>/)
  assert.match(c.out(), /default:.*current directory/)
  const bad = capture()
  assert.equal(await main(['--to', '6.0.12'], bad.io), 1)
  assert.equal(bad.out(), '')
  assert.match(bad.err(), /arguments/i)
})
test('failed planner precondition never emits success or commits', async () => {
  const c = capture(), calls = []
  const deps = { preflightGit: async () => {
    calls.push('git')
    throw new Error('dirty dependency files')
  } }
  assert.equal(await main(['abcdef0'], c.io, deps), 1)
  assert.deepEqual(calls, ['git'])
  assert.equal(c.out(), '')
  assert.match(c.err(), /dirty/)
})
test('direct transaction verifies then commits before emitting a completed result', async (t) => {
  const { gitProject } = await import('./helpers/git-project.js')
  const { preflightGit } = await import('../src/git.js')
  const { loadGraph } = await import('../src/graph.js')
  const { itemId } = await import('../src/planner.js')
  const { readFile, writeFile, mkdir } = await import('node:fs/promises'), path = await import('node:path')
  const f = await gitProject(t), guard = await preflightGit(f.root), graph = await loadGraph(f.root), events = []
  const item = { id: itemId('e2e-target', 'node_modules/e2e-target'), package: 'e2e-target', version: '6.0.9', targetLocation: 'node_modules/e2e-target', minimumSafeVersion: '6.0.10', resolution: 'complete', choices: [{ strategy: 'update-within-declared-range', targetPackage: 'e2e-target', targetLocation: 'node_modules/e2e-target', currentVersion: '6.0.9', targetVersion: '6.0.12', affectedConsumers: [{ location: '', requestedName: 'e2e-target', type: 'dependencies' }] }] }
  const evidence = { item, graph, auditRows: [], incoming: graph.edges, directDeclarations: [{ field: 'dependencies', requestedName: 'e2e-target', spec: '^6.0.8' }], upstream: [] }
  const c = capture()
  const deps = { preflightGit: async () => guard, readPlanner: async () => {
    events.push('plan')
    return { rows: [item] }
  }, readEvidence: async () => evidence, executeActions: async () => {
    const manifest = { ...f.manifest, dependencies: { 'e2e-target': '^6.0.12' } }, lock = structuredClone(f.lock)
    lock.packages[''] = manifest
    lock.packages['node_modules/e2e-target'].version = '6.0.12'
    const files = { 'package.json': Buffer.from(JSON.stringify(manifest)), 'package-lock.json': Buffer.from(JSON.stringify(lock)) }
    const expected = { nodes: new Map([...graph.nodes].map(([loc, node]) => [loc, loc === item.targetLocation ? { ...node, version: '6.0.12' } : node])), edges: graph.edges.map(edge => ({ ...edge, rawSpec: '^6.0.12', effectiveSpec: '^6.0.12' })) }
    return { snapshots: [{ choiceIndex: 0, files, graph: expected, candidate: { version: '6.0.12' }, changedVersions: new Map([['e2e-target', ['6.0.12']]]), supportingChanges: [] }], actions: [{ ...item.choices[0], outcome: 'applied' }], coverage: { resolution: 'complete' } }
  }, loadNpmContext: async () => ({ minAgeDays: 7, installArgs: ['install', '--ignore-scripts', '--min-release-age=7'] }), readCatalog: async () => ({ versions: ['6.0.12'], releaseTimes: new Map([['6.0.12', '2026-01-01T00:00:00Z']]) }), readCandidateAdvisories: async () => new Map(), installProject: async (installRoot) => {
    events.push('install')
    const manifest = JSON.parse(await readFile(path.join(installRoot, 'package.json')))
    const lock = structuredClone(f.lock)
    lock.packages[''] = manifest
    lock.packages['node_modules/e2e-target'].version = '6.0.12'
    await writeFile(path.join(installRoot, 'package-lock.json'), JSON.stringify(lock))
    await mkdir(path.join(installRoot, 'node_modules', 'e2e-target'), { recursive: true })
    await writeFile(path.join(installRoot, 'node_modules', 'e2e-target', 'package.json'), JSON.stringify({ name: 'e2e-target', version: '6.0.12' }))
  }, verifyFinalSecurity: async () => {
    assert.equal(c.out(), '')
    events.push('security')
  } }
  assert.equal(await main([item.id, '--format', 'json'], c.io, deps), 0, c.err())
  const result = JSON.parse(c.out())
  assert.equal(result.actions[0].targetVersion, '6.0.12')
  assert.match(result.commits[0].hash, /^[a-f0-9]{40,64}$/)
  assert.deepEqual(events, ['plan', 'install', 'security', 'install', 'security'])
})

test('CLI passes the explicit resolved project to preflight without changing cwd', async () => {
  const path = await import('node:path'), cwd = process.cwd(), target = path.resolve(cwd, '../target project & symbols'), seen = []
  const c = capture()
  assert.equal(await main(['../target project & symbols', 'abcdef0'], c.io, { preflightGit: async (root) => {
    seen.push(root)
    throw new Error('fixture preflight stopped')
  } }), 1)
  assert.deepEqual(seen, [target])
  assert.equal(process.cwd(), cwd)
  assert.equal(c.out(), '')
})
test('--clear-cache reaches the planner adapter only when supplied', async () => {
  const seen = []
  const deps = {
    preflightGit: async () => ({ root: '/project' }),
    loadProject: async () => ({ root: '/project' }),
    readPlanner: async (root, run, options) => {
      seen.push(options)
      throw new Error('stop after planner')
    },
  }
  assert.equal(await main(['abcdef0', '--clear-cache'], capture().io, deps), 1)
  assert.equal(await main(['abcdef0'], capture().io, deps), 1)
  assert.deepEqual(seen, [{ clearCache: true }, { clearCache: false }])
})
test('help lists --clear-cache aligned and --clear-cache never reaches git for help or version', async () => {
  const c = capture()
  assert.equal(await main(['--clear-cache', '--help'], c.io, { preflightGit: () => assert.fail('must not run') }), 0)
  assert.match(c.out(), /^ {2}--clear-cache {2,}Delete analysis caches \(planner, audit, paths, versions\); with no item ID, only clear$/m)
  assert.equal(await main(['--clear-cache', '--version'], capture().io, { readPlanner: () => assert.fail('must not run') }), 0)
})
test('--clear-cache without an item ID only asks the planner chain to clear', async () => {
  const events = []
  const deps = {
    clearPlannerCache: async (cwd) => {
      events.push(['clear planner', cwd])
    },
    preflightGit: () => assert.fail('must not touch git'),
    readPlanner: () => assert.fail('must not plan'),
  }
  const c = capture()
  assert.equal(await main(['--clear-cache'], c.io, deps), 0)
  assert.deepEqual(events, [['clear planner', process.cwd()]])
  assert.equal(c.out(), '')
  const bad = capture()
  assert.equal(await main([], bad.io, deps), 1)
  assert.match(bad.err(), /item ID/)
})
test('a failing planner clear in clear-only mode exits 1', async () => {
  const c = capture()
  assert.equal(await main(['--clear-cache'], c.io, { clearPlannerCache: async () => {
    throw new Error('npm-dep-upgrade-plan --clear-cache failed: EACCES')
  } }), 1)
  assert.equal(c.out(), '')
  assert.match(c.err(), /npm-dep-upgrade: .*EACCES/)
})

const toolchainChoice = { strategy: 'upgrade-angular-toolchain', targetPackage: '@angular/cli', targetLocation: 'node_modules/@angular/cli', currentVersion: '21.2.26', targetVersion: '21.2.27', affectedConsumers: [{ location: 'node_modules/@angular/build', requestedName: 'e2e-target', type: 'dependencies' }] }
const withinChoice = { strategy: 'update-within-declared-range', targetPackage: 'e2e-target', targetLocation: 'node_modules/e2e-target', currentVersion: '6.0.9', targetVersion: '6.0.12', affectedConsumers: [{ location: '', requestedName: 'e2e-target', type: 'dependencies' }] }

// Dependency files after a synthetic line migration: the line's anchor moves to the planned version.
function lineFiles(current, choice) {
  const manifest = JSON.parse(current['package.json']), lock = JSON.parse(current['package-lock.json'])
  manifest.devDependencies = { ...manifest.devDependencies, [choice.targetPackage]: choice.targetVersion }
  lock.packages[''] = manifest
  lock.packages[choice.targetLocation] = { version: choice.targetVersion, dev: true }
  return { 'package.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'package-lock.json': Buffer.from(JSON.stringify(lock, null, 2) + '\n') }
}

// A real Git fixture whose stubbed line migrations commit real bytes, so the guard, recovery and reload are exercised.
async function toolchainFixture(t, { choices, targetGone = false, resolution = 'complete' }) {
  const { gitProject } = await import('./helpers/git-project.js')
  const { preflightGit, commitUpgrade, readDependencyFiles } = await import('../src/git.js')
  const { recordOwnedFiles } = await import('../src/recovery.js')
  const { loadGraph } = await import('../src/graph.js')
  const { itemId } = await import('../src/planner.js')
  const { writeFile } = await import('node:fs/promises'), path = await import('node:path')
  const f = await gitProject(t), guard = await preflightGit(f.root), start = guard.head, events = [], seen = {}
  const item = { id: itemId('e2e-target', 'node_modules/e2e-target'), package: 'e2e-target', version: '6.0.9', targetLocation: 'node_modules/e2e-target', minimumSafeVersion: '6.0.10', resolution, choices }
  const manifest = { ...f.manifest, devDependencies: { '@angular/cli': '21.2.27' } }, lock = structuredClone(f.lock)
  lock.packages[''] = manifest
  lock.packages['node_modules/@angular/cli'] = { version: '21.2.27', dev: true }
  if (targetGone) lock.packages['node_modules/e2e-target'].version = '6.0.12'
  const toolchainFiles = { 'package.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'package-lock.json': Buffer.from(JSON.stringify(lock, null, 2) + '\n') }
  const c = capture()
  const deps = {
    preflightGit: async () => guard,
    loadProject: async (root) => {
      events.push('project')
      const { loadProject } = await import('../src/project.js')
      return loadProject(root)
    },
    readPlanner: async () => ({ rows: [item] }),
    loadNpmContext: async () => {
      events.push('context')
      return { minAgeDays: 7, installArgs: ['install', '--ignore-scripts', '--min-release-age=7'] }
    },
    migrateLine: async (args) => {
      const { name } = args.line
      events.push(name)
      seen[name] = args
      seen[`${name}Head`] = args.guard.head
      const files = name === 'toolchain' ? toolchainFiles : lineFiles(args.guard.originalFiles, args.choice)
      for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(args.guard.root, file), bytes)
      await recordOwnedFiles(args.guard, files)
      const commit = await commitUpgrade(args.guard, files, { package: args.choice.targetPackage, oldVersion: args.choice.currentVersion, newVersion: args.choice.targetVersion, strategy: args.line.strategy, description: args.line.description(args.choice.targetVersion) }, args.options)
      args.guard.head = commit.hash
      args.guard.originalFiles = { ...files }
      args.guard.ownedFiles = { ...files }
      seen[`${name}Commit`] = commit
      seen[`${name}Files`] = files
      return { commit, action: { ...args.choice, outcome: 'applied', targetLocations: [args.choice.targetLocation], releasedAt: '2026-01-01T00:00:00Z', supportingChanges: [] } }
    },
    loadGraph: async (root, options) => (options?.actual ? { nodes: new Map(), edges: [] } : loadGraph(root)),
    readEvidence: async (project, selected) => {
      events.push('evidence')
      seen.evidenceItem = selected
      const graph = await loadGraph(project.root)
      return { item: selected, graph, auditRows: [], incoming: graph.edges.filter(edge => edge.to === selected.targetLocation), directDeclarations: [], upstream: [] }
    },
    createStagingProject: async (project, context) => {
      events.push('staging')
      const { createStagingProject } = await import('../src/staging.js')
      seen.stagingManifest = project.manifestBytes
      return createStagingProject(project, context)
    },
    executeActions: async (project, selected, evidence, context, adapters) => {
      events.push('execute')
      seen.executeItem = selected
      const files = await readDependencyFiles(adapters.staging.root)
      const bumped = JSON.parse(files['package-lock.json'])
      bumped.packages['node_modules/e2e-target'].version = '6.0.12'
      files['package-lock.json'] = Buffer.from(JSON.stringify(bumped, null, 2) + '\n')
      return { snapshots: [{ choiceIndex: 0, files, graph: { nodes: new Map(), edges: [] }, candidate: { version: '6.0.12' } }], actions: [{ ...selected.choices[0], outcome: 'applied', targetLocations: ['node_modules/e2e-target'], releasedAt: '2026-01-01T00:00:00Z', supportingChanges: [] }], coverage: { resolution: 'complete' } }
    },
    installProject: async () => {},
    verifyFinalSecurity: async () => {},
    commitSnapshots: async (currentGuard, snapshots, actions, context, options, adapters) => {
      events.push('commit')
      const commits = []
      for (const snapshot of snapshots) {
        for (const [name, bytes] of Object.entries(snapshot.files)) await writeFile(path.join(currentGuard.root, name), bytes)
        await recordOwnedFiles(currentGuard, snapshot.files)
        const action = actions[snapshot.choiceIndex]
        const committed = await (adapters.commitUpgrade || commitUpgrade)(currentGuard, snapshot.files, { package: action.targetPackage, oldVersion: action.currentVersion, newVersion: action.targetVersion, strategy: action.strategy, description: `bump ${action.targetPackage} from ${action.currentVersion} to ${action.targetVersion}` }, options)
        commits.push({ ...committed, actionIndex: snapshot.choiceIndex })
        currentGuard.head = committed.hash
        currentGuard.originalFiles = { ...snapshot.files }
        currentGuard.ownedFiles = { ...snapshot.files }
      }
      return commits
    },
  }
  return { f, guard, start, item, c, deps, events, seen, toolchainFiles }
}

const headOf = async (root) => {
  const { runGit } = await import('../src/git.js')
  return (await runGit(root, ['rev-parse', 'HEAD'])).trim()
}

test('a toolchain-only finding commits the migration without a staging project', async (t) => {
  const x = await toolchainFixture(t, { choices: [toolchainChoice] })
  x.deps.createStagingProject = () => assert.fail('must not stage')
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  const result = JSON.parse(x.c.out())
  assert.equal(result.resolution, 'complete')
  assert.deepEqual(result.actions.map(a => [a.strategy, a.outcome]), [['upgrade-angular-toolchain', 'applied']])
  assert.deepEqual(result.commits.map(c => [c.hash, c.actionIndex]), [[x.seen.toolchainCommit.hash, 0]])
  assert.equal(await headOf(x.f.root), x.seen.toolchainCommit.hash)
  assert.equal(x.seen.toolchain.item, x.item)
  assert.equal(x.seen.toolchain.choice, toolchainChoice)
  assert.equal(x.seen.toolchain.guard, x.guard)
  assert.equal(x.seen.toolchain.adapters.stderr, x.c.io.stderr)
  assert.deepEqual(x.events, ['project', 'context', 'toolchain', 'project'])
})

test('a toolchain migration runs before evidence and the remaining choices are committed after it', async (t) => {
  const x = await toolchainFixture(t, { choices: [withinChoice, toolchainChoice] })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.deepEqual(x.events, ['project', 'context', 'toolchain', 'project', 'evidence', 'staging', 'execute', 'commit'])
  assert.deepEqual(x.seen.evidenceItem.choices, [withinChoice])
  assert.deepEqual(x.seen.executeItem.choices, [withinChoice])
  assert.deepEqual(x.seen.stagingManifest, x.toolchainFiles['package.json'])
  const result = JSON.parse(x.c.out())
  assert.deepEqual(result.actions.map(a => a.strategy), ['upgrade-angular-toolchain', 'update-within-declared-range'])
  assert.equal(result.commits.length, 2)
  assert.equal(result.commits[0].hash, x.seen.toolchainCommit.hash)
  assert.deepEqual(result.commits.map(c => c.actionIndex), [0, 1])
  assert.match(result.commits[1].subject, /bump e2e-target from 6\.0\.9 to 6\.0\.12/)
  const { runGit } = await import('../src/git.js')
  assert.equal((await runGit(x.f.root, ['rev-parse', `${result.commits[1].hash}^`])).trim(), x.seen.toolchainCommit.hash)
  assert.equal((await runGit(x.f.root, ['rev-parse', `${x.seen.toolchainCommit.hash}^`])).trim(), x.start)
})

test('remaining actions are already satisfied when the toolchain removes the target installation', async (t) => {
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice], targetGone: true })
  x.deps.createStagingProject = () => assert.fail('must not stage')
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  const result = JSON.parse(x.c.out())
  assert.equal(result.resolution, 'complete')
  assert.deepEqual(result.actions.map(a => [a.strategy, a.outcome]), [['upgrade-angular-toolchain', 'applied'], ['update-within-declared-range', 'already-satisfied']])
  assert.deepEqual(result.actions[1].targetLocations, ['node_modules/e2e-target'])
  assert.deepEqual(result.commits.map(c => [c.hash, c.actionIndex]), [[x.seen.toolchainCommit.hash, 0]])
})

test('a failed toolchain migration exits 1 with its stage and runs nothing after it', async (t) => {
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice] })
  x.deps.migrateLine = async ({ guard }) => {
    guard.installedTreeMayHaveChanged = true
    throw Object.assign(new Error('nx migrate failed; inspect nx diagnostics. Working tree restored.'), { stage: 'migration' })
  }
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.out(), '')
  assert.equal(x.c.err(), 'npm-dep-upgrade: migration: nx migrate failed; inspect nx diagnostics. Working tree restored. node_modules may have changed.\n')
  assert.equal(await headOf(x.f.root), x.start)
})

test('a later-phase failure keeps the toolchain commit and names it', async (t) => {
  const { readFile } = await import('node:fs/promises'), path = await import('node:path')
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice] })
  x.deps.executeActions = async () => {
    throw Object.assign(new Error('Cannot resolve selected upgrades'), { stage: 'resolution' })
  }
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.out(), '')
  assert.match(x.c.err(), new RegExp(`^npm-dep-upgrade: resolution: Cannot resolve selected upgrades; completed commits: ${x.seen.toolchainCommit.hash}\\.`))
  assert.doesNotMatch(x.c.err(), /Original dependency files were not changed/)
  assert.equal(await headOf(x.f.root), x.seen.toolchainCommit.hash)
  assert.deepEqual(await readFile(path.join(x.f.root, 'package.json')), x.toolchainFiles['package.json'])
})

test('a commit-phase failure after the toolchain commit restores only to the toolchain state', async (t) => {
  const { readFile, writeFile } = await import('node:fs/promises'), path = await import('node:path')
  const { recordOwnedFiles } = await import('../src/recovery.js')
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice] })
  x.deps.commitSnapshots = async (guard, snapshots) => {
    for (const [name, bytes] of Object.entries(snapshots[0].files)) await writeFile(path.join(guard.root, name), bytes)
    await recordOwnedFiles(guard, snapshots[0].files)
    throw Object.assign(new Error('pre-commit hook rejected'), { stage: 'commit', committed: [] })
  }
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.out(), '')
  assert.match(x.c.err(), new RegExp(`^npm-dep-upgrade: commit: pre-commit hook rejected; completed commits: ${x.seen.toolchainCommit.hash}\\..* Dependency files restored\\.`))
  assert.equal(await headOf(x.f.root), x.seen.toolchainCommit.hash)
  for (const name of ['package.json', 'package-lock.json']) assert.deepEqual(await readFile(path.join(x.f.root, name)), x.toolchainFiles[name])
})

test('the commit sequence receives the toolchain commit so later failures list it', async (t) => {
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice] })
  const base = x.deps.commitSnapshots
  let completed
  x.deps.commitSnapshots = async (guard, snapshots, actions, context, options, adapters) => {
    completed = adapters.completedCommits
    return base(guard, snapshots, actions, context, options, adapters)
  }
  assert.equal(await main([x.item.id], x.c.io, x.deps), 0, x.c.err())
  assert.deepEqual(completed.map(c => [c.hash, c.actionIndex]), [[x.seen.toolchainCommit.hash, 0]])
})

test('a toolchain-only finding keeps the planned resolution while the target installation remains', async (t) => {
  const x = await toolchainFixture(t, { choices: [toolchainChoice], resolution: 'partial' })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.equal(JSON.parse(x.c.out()).resolution, 'partial')
})

test('a removed target reports complete even for a partial plan', async (t) => {
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice], targetGone: true, resolution: 'partial' })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.equal(JSON.parse(x.c.out()).resolution, 'complete')
})

test('a toolchain commit Git created before the migration failed is named and not restored over', async (t) => {
  const { readFile } = await import('node:fs/promises'), path = await import('node:path')
  const x = await toolchainFixture(t, { choices: [toolchainChoice, withinChoice] })
  const base = x.deps.migrateLine
  x.deps.migrateLine = async (args) => {
    const { commit } = await base(args)
    throw Object.assign(new Error('Dependency files changed after commit'), { stage: 'commit', createdCommit: commit })
  }
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.out(), '')
  assert.equal(x.c.err(), `npm-dep-upgrade: commit: Dependency files changed after commit; completed commits: ${x.seen.toolchainCommit.hash}. Dependency files were not restored over the toolchain commit; inspect Git state.\n`)
  assert.equal(await headOf(x.f.root), x.seen.toolchainCommit.hash)
  assert.deepEqual(await readFile(path.join(x.f.root, 'package.json')), x.toolchainFiles['package.json'])
})

const goneConsumer = { location: 'node_modules/e2e-gone', requestedName: 'e2e-target', type: 'dependencies' }
test('a remaining choice whose consumers the toolchain moved is already satisfied and not executed', async (t) => {
  const gone = { ...withinChoice, targetVersion: '6.0.10', affectedConsumers: [goneConsumer] }
  const x = await toolchainFixture(t, { choices: [gone, toolchainChoice, withinChoice] })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.deepEqual(x.seen.executeItem.choices, [withinChoice])
  const result = JSON.parse(x.c.out())
  assert.deepEqual(result.actions.map(a => [a.strategy, a.targetVersion, a.outcome]), [['upgrade-angular-toolchain', '21.2.27', 'applied'], ['update-within-declared-range', '6.0.10', 'already-satisfied'], ['update-within-declared-range', '6.0.12', 'applied']])
  assert.deepEqual(result.actions[1].affectedConsumers, [goneConsumer])
  assert.deepEqual(result.commits.map(c => c.actionIndex), [0, 2])
})

test('a remaining choice keeps only the consumers still on the target', async (t) => {
  const mixed = { ...withinChoice, affectedConsumers: [...withinChoice.affectedConsumers, goneConsumer] }
  const x = await toolchainFixture(t, { choices: [toolchainChoice, mixed] })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.deepEqual(x.seen.executeItem.choices, [withinChoice])
  assert.deepEqual(JSON.parse(x.c.out()).commits.map(c => c.actionIndex), [0, 1])
})

test('no staging is created when every remaining choice lost its consumers', async (t) => {
  const gone = { ...withinChoice, affectedConsumers: [goneConsumer] }
  const x = await toolchainFixture(t, { choices: [toolchainChoice, gone], resolution: 'partial' })
  x.deps.createStagingProject = () => assert.fail('must not stage')
  x.deps.executeActions = () => assert.fail('must not execute')
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  const result = JSON.parse(x.c.out())
  assert.equal(result.resolution, 'partial')
  assert.deepEqual(result.actions.map(a => a.outcome), ['applied', 'already-satisfied'])
  assert.equal(result.commits.length, 1)
})

// A second line injected through the `lines` dependency stands in for the runtime line in multi-phase runs.
const syntheticLine = { key: 'synthetic', name: 'synthetic', strategy: 'upgrade-angular-synthetic', anchor: '@e2e/synthetic', members: ['@e2e/synthetic'], overrides: [], allowlist: ['@e2e/synthetic'], unchecked: [], description: version => `migrate synthetic line to ${version}` }
const syntheticChoice = { strategy: 'upgrade-angular-synthetic', targetPackage: '@e2e/synthetic', targetLocation: 'node_modules/@e2e/synthetic', currentVersion: '1.0.0', targetVersion: '1.0.1', affectedConsumers: [{ location: '', requestedName: 'e2e-target', type: 'dependencies' }] }

async function twoLineFixture(t, options) {
  const { ANGULAR_LINES } = await import('../src/angular-lines.js')
  const x = await toolchainFixture(t, options)
  x.deps.lines = [ANGULAR_LINES[0], syntheticLine]
  return x
}

test('two line choices run as pre-phases in registry order, each with its own commit', async (t) => {
  const x = await twoLineFixture(t, { choices: [syntheticChoice, withinChoice, toolchainChoice] })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.deepEqual(x.events, ['project', 'context', 'toolchain', 'project', 'synthetic', 'project', 'evidence', 'staging', 'execute', 'commit'])
  assert.equal(x.seen.synthetic.line, syntheticLine)
  assert.deepEqual(x.seen.synthetic.choice, syntheticChoice)
  assert.equal(x.seen.syntheticHead, x.seen.toolchainCommit.hash)
  assert.deepEqual(x.seen.evidenceItem.choices, [withinChoice])
  assert.deepEqual(x.seen.stagingManifest, x.seen.syntheticFiles['package.json'])
  const result = JSON.parse(x.c.out())
  assert.deepEqual(result.actions.map(a => [a.strategy, a.outcome]), [['upgrade-angular-toolchain', 'applied'], ['upgrade-angular-synthetic', 'applied'], ['update-within-declared-range', 'applied']])
  assert.deepEqual(result.commits.map(c => [c.hash, c.actionIndex]).slice(0, 2), [[x.seen.toolchainCommit.hash, 0], [x.seen.syntheticCommit.hash, 1]])
  assert.deepEqual(result.commits.map(c => c.actionIndex), [0, 1, 2])
  assert.match(result.commits[1].subject, /migrate synthetic line to 1\.0\.1/)
  const { runGit } = await import('../src/git.js')
  assert.equal((await runGit(x.f.root, ['rev-parse', `${result.commits[2].hash}^`])).trim(), x.seen.syntheticCommit.hash)
  assert.equal((await runGit(x.f.root, ['rev-parse', `${x.seen.syntheticCommit.hash}^`])).trim(), x.seen.toolchainCommit.hash)
})

test('line-only findings commit every phase and keep the planned resolution', async (t) => {
  const x = await twoLineFixture(t, { choices: [toolchainChoice, syntheticChoice], resolution: 'partial' })
  x.deps.createStagingProject = () => assert.fail('must not stage')
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  const result = JSON.parse(x.c.out())
  assert.equal(result.resolution, 'partial')
  assert.deepEqual(result.commits.map(c => [c.hash, c.actionIndex]), [[x.seen.toolchainCommit.hash, 0], [x.seen.syntheticCommit.hash, 1]])
  assert.equal(await headOf(x.f.root), x.seen.syntheticCommit.hash)
})

test('a failure in the second phase keeps and names the first commit without restoring over it', async (t) => {
  const { readFile } = await import('node:fs/promises'), path = await import('node:path')
  const x = await twoLineFixture(t, { choices: [toolchainChoice, syntheticChoice, withinChoice] })
  const base = x.deps.migrateLine
  x.deps.migrateLine = async (args) => {
    if (args.line === syntheticLine) {
      args.guard.installedTreeMayHaveChanged = true
      throw Object.assign(new Error('nx migrate failed; inspect nx diagnostics. Working tree restored'), { stage: 'migration' })
    }
    return base(args)
  }
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.out(), '')
  assert.equal(x.c.err(), `npm-dep-upgrade: migration: nx migrate failed; inspect nx diagnostics. Working tree restored; completed commits: ${x.seen.toolchainCommit.hash}. Dependency files were not changed after the toolchain commit. node_modules may have changed.\n`)
  assert.equal(await headOf(x.f.root), x.seen.toolchainCommit.hash)
  for (const name of ['package.json', 'package-lock.json']) assert.deepEqual(await readFile(path.join(x.f.root, name)), x.toolchainFiles[name])
})

test('a second-phase commit Git created before the migration failed is named with the first', async (t) => {
  const { readFile } = await import('node:fs/promises'), path = await import('node:path')
  const x = await twoLineFixture(t, { choices: [toolchainChoice, syntheticChoice, withinChoice] })
  const base = x.deps.migrateLine
  x.deps.migrateLine = async (args) => {
    const migrated = await base(args)
    if (args.line === syntheticLine) throw Object.assign(new Error('Dependency files changed after commit'), { stage: 'commit', createdCommit: migrated.commit })
    return migrated
  }
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.err(), `npm-dep-upgrade: commit: Dependency files changed after commit; completed commits: ${x.seen.toolchainCommit.hash}, ${x.seen.syntheticCommit.hash}. Dependency files were not restored over the synthetic commit; inspect Git state.\n`)
  assert.equal(await headOf(x.f.root), x.seen.syntheticCommit.hash)
  assert.deepEqual(await readFile(path.join(x.f.root, 'package.json')), x.seen.syntheticFiles['package.json'])
})

test('a failure after every phase names all phase commits and the last phase', async (t) => {
  const x = await twoLineFixture(t, { choices: [toolchainChoice, syntheticChoice, withinChoice] })
  x.deps.executeActions = async () => {
    throw Object.assign(new Error('Cannot resolve selected upgrades'), { stage: 'resolution' })
  }
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.err(), `npm-dep-upgrade: resolution: Cannot resolve selected upgrades; completed commits: ${x.seen.toolchainCommit.hash}, ${x.seen.syntheticCommit.hash}. Dependency files were not changed after the synthetic commit.\n`)
  assert.equal(await headOf(x.f.root), x.seen.syntheticCommit.hash)
})

test('the target removed by the first phase skips later phases and reports them already satisfied', async (t) => {
  const x = await twoLineFixture(t, { choices: [toolchainChoice, syntheticChoice, withinChoice], targetGone: true, resolution: 'partial' })
  x.deps.createStagingProject = () => assert.fail('must not stage')
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.deepEqual(x.events, ['project', 'context', 'toolchain', 'project'])
  const result = JSON.parse(x.c.out())
  assert.equal(result.resolution, 'complete')
  assert.deepEqual(result.actions.map(a => [a.strategy, a.outcome]), [['upgrade-angular-toolchain', 'applied'], ['upgrade-angular-synthetic', 'already-satisfied'], ['update-within-declared-range', 'already-satisfied']])
  assert.deepEqual(result.commits.map(c => [c.hash, c.actionIndex]), [[x.seen.toolchainCommit.hash, 0]])
})

test('a later line choice keeps only consumers still on the target and is skipped when none remain', async (t) => {
  const mixed = { ...syntheticChoice, affectedConsumers: [...syntheticChoice.affectedConsumers, goneConsumer] }
  const kept = await twoLineFixture(t, { choices: [toolchainChoice, mixed, withinChoice] })
  assert.equal(await main([kept.item.id, '--format', 'json'], kept.c.io, kept.deps), 0, kept.c.err())
  assert.deepEqual(kept.seen.synthetic.choice, syntheticChoice)
  assert.deepEqual(JSON.parse(kept.c.out()).commits.map(c => c.actionIndex), [0, 1, 2])

  const gone = { ...syntheticChoice, affectedConsumers: [goneConsumer] }
  const x = await twoLineFixture(t, { choices: [toolchainChoice, gone, withinChoice] })
  assert.equal(await main([x.item.id, '--format', 'json'], x.c.io, x.deps), 0, x.c.err())
  assert.ok(!x.events.includes('synthetic'))
  const result = JSON.parse(x.c.out())
  assert.deepEqual(result.actions.map(a => [a.strategy, a.outcome]), [['upgrade-angular-toolchain', 'applied'], ['upgrade-angular-synthetic', 'already-satisfied'], ['update-within-declared-range', 'applied']])
  assert.deepEqual(result.actions[1].affectedConsumers, [goneConsumer])
  assert.deepEqual(result.commits.map(c => c.actionIndex), [0, 2])
})

async function secondPhaseFails(t, failure) {
  const x = await twoLineFixture(t, { choices: [toolchainChoice, syntheticChoice, withinChoice] })
  const base = x.deps.migrateLine
  x.deps.migrateLine = async (args) => {
    if (args.line !== syntheticLine) return base(args)
    args.guard.installedTreeMayHaveChanged = true
    throw failure()
  }
  x.deps.readEvidence = () => assert.fail('must not read evidence')
  assert.equal(await main([x.item.id], x.c.io, x.deps), 1)
  assert.equal(x.c.out(), '')
  return x
}

test('a second-phase message ending in a period continues with the completed commits as a sentence', async (t) => {
  const x = await secondPhaseFails(t, () => Object.assign(new Error('nx migrate failed; inspect nx diagnostics. Working tree restored.'), { stage: 'migration', workingTreeRestored: true }))
  assert.equal(x.c.err(), `npm-dep-upgrade: migration: nx migrate failed; inspect nx diagnostics. Working tree restored. Completed commits: ${x.seen.toolchainCommit.hash}. Dependency files were not changed after the toolchain commit. node_modules may have changed.\n`)
})

test('a second phase whose revert failed does not claim the dependency files are unchanged', async (t) => {
  const x = await secondPhaseFails(t, () => Object.assign(new Error('nx migrate failed; inspect nx diagnostics. Working tree could not be fully restored: left in place for you to inspect: package.json (changed outside this run); inspect Git state.'), { stage: 'migration', workingTreeRestored: false }))
  assert.equal(x.c.err(), `npm-dep-upgrade: migration: nx migrate failed; inspect nx diagnostics. Working tree could not be fully restored: left in place for you to inspect: package.json (changed outside this run); inspect Git state. Completed commits: ${x.seen.toolchainCommit.hash}. node_modules may have changed.\n`)
  assert.doesNotMatch(x.c.err(), /were not changed after/)
  assert.equal(await headOf(x.f.root), x.seen.toolchainCommit.hash)
})
