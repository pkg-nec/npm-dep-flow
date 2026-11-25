import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { runDebug } from '../src/debug.js'
import { DeadlineReached } from '../src/errors.js'
import { storePath } from '../src/ignores.js'
import { runAutopilot } from '../src/runner.js'
import { choice, plannerRow, upgradeReport } from './helpers/fixtures.js'

const WITHIN = 'update-within-declared-range'
const PARENT = 'upgrade-via-parent-dependency'
const TOOLCHAIN = 'upgrade-angular-toolchain'

const projects = [
  { module: 'web', path: '/r/web', relativePath: 'web', gitCommitArgs: [] },
  { module: 'api', path: '/r/api', relativePath: 'api', gitCommitArgs: [] },
]
const config = { repo: '/r', defaultBranch: 'main', pollIntervalSeconds: 60, deadline: '00:00', projects }

const finding = (id, strategies = [WITHIN], severity = 'high') => plannerRow({ id, severity, choices: strategies.map(choice) })

function reportFor(id, strategies = [WITHIN], commits = 1) {
  const actions = strategies.map((strategy, index) => ({
    strategy,
    targetPackage: strategy === TOOLCHAIN ? '@angular/cli' : `pkg${id}`,
    currentVersion: '1.0.0',
    targetVersion: strategy === TOOLCHAIN ? '20.3.4' : `1.0.${id.length + index}`,
    outcome: 'applied',
  }))
  return upgradeReport({ id, actions, commits: Array.from({ length: commits }, (_, index) => ({ hash: `h${index}`, subject: `s${id}.${index}` })) })
}

function makeEnv({ rows = {}, openPrs = [[]], upgrade, rebase = [true], newCommits = [false], dirty = false, onWork = false, sleep, commits = {}, strategies = {}, keepFindings = false, runConfig = config, loadIgnores, based = {}, closeFails = [] } = {}) {
  const events = []
  const logs = []
  const fixed = new Set()
  const prQueue = [...openPrs]
  const rebaseQueue = [...rebase]
  const newQueue = [...newCommits]
  const state = { commits: 0, dirty }
  const created = []
  const closed = []
  const basedQueues = Object.fromEntries(Object.entries(based).map(([branch, value]) => [branch, Array.isArray(value) ? [...value] : [value]]))
  const closeQueue = [...closeFails]

  const tools = {
    async plan(project) {
      return (rows[project.module] ?? []).filter(row => !fixed.has(`${project.module}:${row.id}`))
    },
    async upgrade(project, id) {
      events.push(`upgrade:${project.module}:${id}`)
      state.commits += 1
      if (upgrade) await upgrade(project, id, events)
      if (!keepFindings) fixed.add(`${project.module}:${id}`)
      return reportFor(id, strategies[id] ?? [WITHIN], commits[id] ?? 1)
    },
  }
  const git = {
    async fetch() {
      events.push('fetch')
    },
    async isClean() {
      return !state.dirty
    },
    async onWorkBranch() {
      return onWork
    },
    async discardWork() {
      events.push('discardWork')
      state.dirty = false
    },
    async syncDefault() {
      events.push('syncDefault')
    },
    async createWorkBranch() {
      events.push('createWorkBranch')
    },
    async head() {
      return `sha-${state.commits}`
    },
    async resetHard(to) {
      events.push(`resetHard:${to}`)
    },
    async hasNewDefaultCommits() {
      return newQueue.length > 1 ? newQueue.shift() : newQueue[0]
    },
    async rebaseOnDefault() {
      const ok = rebaseQueue.length > 1 ? rebaseQueue.shift() : rebaseQueue[0]
      events.push(`rebase:${ok}`)
      if (!ok) fixed.clear()
      return ok
    },
    async isBasedOnDefault(branch) {
      events.push(`based:${branch}`)
      const queue = basedQueues[branch]
      if (!queue) return true
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    },
    async renameBranch(to) {
      events.push(`rename:${to}`)
    },
    async push(branch) {
      events.push(`push:${branch}`)
    },
  }
  const gh = {
    async currentUser() {
      return 'maw'
    },
    async openPrs() {
      events.push('openPrs')
      const next = prQueue.length > 1 ? prQueue.shift() : prQueue[0]
      if (next instanceof Error) throw next
      return next
    },
    async closePr(number, comment) {
      events.push(`close:${number}`)
      const failure = closeQueue.shift()
      if (failure instanceof Error) throw failure
      closed.push({ number, comment })
    },
    async ensureLabel() {
      events.push('ensureLabel')
    },
    async createPr(pr) {
      events.push(`createPr:${pr.branch}`)
      created.push(pr)
      return 'https://example.test/pr/1'
    },
  }
  const sleeps = []
  const deadline = {
    async sleep(ms) {
      sleeps.push(ms)
      if (sleeps.length > 50) throw new Error('runaway wait loop')
      if (sleep) await sleep(sleeps.length)
    },
  }

  const context = { config: runConfig, gh, git, tools, deadline, log: line => logs.push(line) }
  if (loadIgnores) context.loadIgnores = loadIgnores

  return { events, created, closed, sleeps, logs, run: () => runAutopilot(context) }
}

test('waits for an open PR, resyncing before and after, then works', async () => {
  const env = makeEnv({ openPrs: [[{ number: 1 }], [{ number: 1 }], []] })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(env.sleeps, [60000, 60000])
  assert.equal(env.events.filter(event => event === 'syncDefault').length, 2)
  assert.ok(env.events.lastIndexOf('syncDefault') < env.events.indexOf('createWorkBranch'))
})

test('keeps waiting while any open PR remains', async () => {
  const env = makeEnv({ openPrs: [[{ number: 1 }, { number: 2 }], [{ number: 2 }], []] })

  await env.run()

  assert.equal(env.sleeps.length, 2)
})

test('a critical finding in a later project is fixed first and published alone', async () => {
  const env = makeEnv({ rows: { web: [finding('1')], api: [finding('2', [WITHIN], 'critical')] } })

  await env.run()

  assert.equal(env.events.find(event => event.startsWith('upgrade:')), 'upgrade:api:2')
  assert.equal(env.created[0].title, 'deps(api): bump pkg2 from 1.0.0 to 1.0.1')
  assert.equal(env.created[0].branch, 'deps/api/pkg2-1.0.1')
  assert.equal(env.created[0].base, 'main')
})

test('the label exists before the branch is pushed and the PR is created', async () => {
  const env = makeEnv({ rows: { web: [finding('1', [WITHIN], 'critical')] } })

  await env.run()

  const { events } = env
  assert.ok(events.indexOf('ensureLabel') < events.indexOf('rename:deps/web/pkg1-1.0.1'))
  assert.ok(events.indexOf('rename:deps/web/pkg1-1.0.1') < events.indexOf('push:deps/web/pkg1-1.0.1'))
  assert.ok(events.indexOf('push:deps/web/pkg1-1.0.1') < events.indexOf('createPr:deps/web/pkg1-1.0.1'))
})

test('drains a module into one fix-vulnerabilities PR', async () => {
  const env = makeEnv({ rows: { web: [finding('1'), finding('22'), finding('333')], api: [finding('4')] } })

  await env.run()

  assert.deepEqual(env.events.filter(event => event.startsWith('upgrade:')).slice(0, 3), ['upgrade:web:1', 'upgrade:web:22', 'upgrade:web:333'])
  assert.equal(env.created[0].branch, 'deps/web/fix-vulnerabilities')
  assert.equal(env.created[0].title, 'deps(web): fix vulnerabilities')
  assert.equal(env.created[0].body, '- s1.0 (1)\n- s22.0 (22)\n- s333.0 (333)')
})

test('a drained batch of one finding with two commits is still fix-vulnerabilities', async () => {
  const env = makeEnv({ rows: { web: [finding('1')] }, commits: { 1: 2 } })

  await env.run()

  assert.equal(env.created[0].branch, 'deps/web/fix-vulnerabilities')
  assert.equal(env.created[0].title, 'deps(web): fix vulnerabilities')
  assert.equal(env.created[0].body, '- s1.0 (1)\n- s1.1 (1)')
})

test('an Angular finding is never batched and is published first', async () => {
  const env = makeEnv({ rows: { web: [finding('1'), finding('22'), finding('9', [TOOLCHAIN])] }, strategies: { 9: [TOOLCHAIN] } })

  await env.run()

  assert.equal(env.created[0].branch, 'deps/web/angular-toolchain-20.3.4')
  assert.equal(env.created[1].branch, 'deps/web/fix-vulnerabilities')
})

test('a finding mixing Angular and parent actions is published as the Angular bump', async () => {
  const env = makeEnv({
    rows: { web: [finding('9', [PARENT, TOOLCHAIN])] },
    strategies: { 9: [PARENT, TOOLCHAIN] },
    commits: { 9: 2 },
  })

  await env.run()

  assert.equal(env.created[0].title, 'deps(web): bump Angular toolchain to 20.3.4')
})

test('a failed upgrade is reset, skipped for its module, and the next candidate is tried', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')], api: [finding('1', [WITHIN], 'critical')] },
    upgrade: async (project) => {
      if (project.module === 'web') throw new Error('upgrade failed')
    },
  })

  await env.run()

  const upgrades = env.events.filter(event => event.startsWith('upgrade:'))
  assert.deepEqual(upgrades, ['upgrade:web:1', 'upgrade:api:1'])
  assert.ok(env.events.includes('resetHard:sha-0'))
  assert.ok(env.events.indexOf('upgrade:web:1') < env.events.findIndex(event => event.startsWith('resetHard:')))
  assert.equal(env.created[0].branch, 'deps/api/pkg1-1.0.1')
})

test('a failed rebase abandons the work and restarts from sync', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')] },
    newCommits: [true, false],
    rebase: [false],
  })

  assert.equal(await env.run(), 'done')

  assert.deepEqual(env.events.filter(event => event.startsWith('push:')), ['push:deps/web/pkg1-1.0.1'])
  assert.ok(env.events.indexOf('rebase:false') < env.events.indexOf('upgrade:web:1', env.events.indexOf('rebase:false')))
  assert.equal(env.events.filter(event => event === 'createWorkBranch').length >= 2, true)
})

test('a restart after an abandoned rebase starts as if just launched', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')] },
    newCommits: [true, false],
    rebase: [false],
  })

  await env.run()

  assert.equal(env.events.filter(event => event === 'upgrade:web:1').length, 2)
})

test('rebase is attempted only when the default branch moved', async () => {
  const env = makeEnv({ rows: { web: [finding('1', [WITHIN], 'critical')] }, newCommits: [true], rebase: [true] })

  await env.run()

  assert.ok(env.events.includes('rebase:true'))
  assert.equal(env.created.length, 1)
})

test('the deadline during a wait returns deadline without publishing', async () => {
  const env = makeEnv({
    openPrs: [[{ number: 1 }]],
    sleep: async () => {
      throw new DeadlineReached()
    },
  })

  assert.equal(await env.run(), 'deadline')
  assert.equal(env.created.length, 0)
})

test('the deadline during an upgrade returns deadline without pushing', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')] },
    upgrade: async () => {
      throw new DeadlineReached()
    },
  })

  assert.equal(await env.run(), 'deadline')
  assert.equal(env.events.some(event => event.startsWith('push:')), false)
  assert.equal(env.created.length, 0)
})

test('a dirty clone is an error', async () => {
  await assert.rejects(makeEnv({ dirty: true }).run(), { code: 'CLONE_DIRTY' })
})

test('five consecutive PR list failures are fatal', async () => {
  const env = makeEnv({ openPrs: [new Error('net')] })

  await assert.rejects(env.run(), { code: 'GH_UNAVAILABLE' })
  assert.equal(env.sleeps.length, 4)
})

test('a single PR list failure is retried', async () => {
  const env = makeEnv({ openPrs: [new Error('net'), []] })

  assert.equal(await env.run(), 'done')
  assert.equal(env.sleeps.length, 1)
})

test('no candidates returns done without a PR', async () => {
  const env = makeEnv({ rows: { web: [finding('1', [WITHIN], 'high')].map(row => ({ ...row, resolution: 'partial' })) } })

  assert.equal(await env.run(), 'done')
  assert.equal(env.created.length, 0)
})

test('an interrupted work branch is discarded instead of failing', async () => {
  const env = makeEnv({ dirty: true, onWork: true })

  assert.equal(await env.run(), 'done')
  assert.ok(env.events.includes('discardWork'))
})

test('a dirty default branch is still an error', async () => {
  const env = makeEnv({ dirty: true, onWork: false })

  await assert.rejects(env.run(), { code: 'CLONE_DIRTY' })
  assert.equal(env.events.includes('discardWork'), false)
})

test('resets to the head captured before a failing upgrade that already committed', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')] },
    upgrade: async () => {
      throw new Error('failed after committing')
    },
  })

  await env.run()

  assert.deepEqual(env.events.filter(event => event.startsWith('resetHard:')), ['resetHard:sha-0'])
})

test('after publishing, waits until the new PR is listed before working again', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')], api: [finding('2', [WITHIN], 'critical')] },
    openPrs: [[], [], [{ number: 1, headRefName: 'deps/web/pkg1-1.0.1' }], []],
  })

  await env.run()

  assert.equal(env.created.length, 2)
  assert.ok(env.sleeps.length >= 2)
  assert.ok(env.events.indexOf('createPr:deps/web/pkg1-1.0.1') < env.events.indexOf('upgrade:api:2'))
  assert.equal(env.events.filter(event => event === 'openPrs').length >= 4, true)
})

test('a finding that stays reported after a successful upgrade is not retried forever', async () => {
  const env = makeEnv({ rows: { web: [finding('1', [WITHIN], 'high')] }, keepFindings: true })

  assert.equal(await env.run(), 'done')
  assert.equal(env.events.filter(event => event.startsWith('upgrade:')).length, 1)
})

const IGNORED_ID = `a1b2c3d${'0'.repeat(57)}`
const stored = (module, id) => ({ module, id, addedAt: '2026-11-13T09:12:04.000Z' })
const ignoringLines = logs => logs.filter(line => line.startsWith('Ignoring '))
const upgrades = events => events.filter(event => event.startsWith('upgrade:'))

test('an ignored finding is never upgraded', async () => {
  const env = makeEnv({
    rows: { web: [finding(IGNORED_ID, [WITHIN], 'critical'), finding('2', [WITHIN], 'critical')] },
    loadIgnores: async () => ({ entries: [stored('web', 'a1b2c3d')], unreadable: false }),
  })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(upgrades(env.events), ['upgrade:web:2'])
  assert.equal(env.created.length, 1)
  assert.equal(env.created[0].branch, 'deps/web/pkg2-1.0.1')
})

test('an ignore added between cycles is honoured without a restart', async () => {
  let reads = 0
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical'), finding(IGNORED_ID, [WITHIN], 'critical')] },
    loadIgnores: async () => {
      reads += 1
      return { entries: reads === 1 ? [] : [stored('web', 'a1b2c3d')], unreadable: false }
    },
  })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(upgrades(env.events), ['upgrade:web:1'])
  assert.equal(env.created.length, 1)
})

test('each work cycle logs one line naming the ignored findings', async () => {
  const env = makeEnv({
    rows: { web: [finding(IGNORED_ID), finding('1'), finding('22')] },
    loadIgnores: async () => ({ entries: [stored('web', 'a1b2c3d')], unreadable: false }),
  })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(upgrades(env.events), ['upgrade:web:1', 'upgrade:web:22'])
  assert.deepEqual(ignoringLines(env.logs), [
    'Ignoring 1 finding(s): web:a1b2c3d (brace-expansion@5.0.9)',
    'Ignoring 1 finding(s): web:a1b2c3d (brace-expansion@5.0.9)',
  ])
})

test('a cycle that publishes nothing still logs the ignored findings', async () => {
  const env = makeEnv({
    rows: { web: [finding(IGNORED_ID)], api: [finding(`4c5b6a7${'0'.repeat(57)}`, [WITHIN], 'low')] },
    loadIgnores: async () => ({ entries: [stored('web', 'a1b2c3d'), stored('api', '4c5b6a7')], unreadable: false }),
  })

  assert.equal(await env.run(), 'done')
  assert.equal(env.created.length, 0)
  assert.deepEqual(ignoringLines(env.logs), ['Ignoring 2 finding(s): web:a1b2c3d (brace-expansion@5.0.9), api:4c5b6a7 (brace-expansion@5.0.9)'])
})

test('a cycle that ignores nothing logs no ignoring line', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical')] },
    loadIgnores: async () => ({ entries: [stored('api', 'a1b2c3d')], unreadable: false }),
  })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(upgrades(env.events), ['upgrade:web:1'])
  assert.deepEqual(ignoringLines(env.logs), [])
})

test('an unreadable store warns once per run and keeps working, naming the file that was read', async () => {
  const store = storePath(config.repo, join('/elsewhere', 'npm-dep-autopilot'))
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical'), finding('2', [WITHIN], 'critical')] },
    loadIgnores: async () => ({ entries: [], unreadable: true, path: store }),
  })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(upgrades(env.events), ['upgrade:web:1', 'upgrade:web:2'])
  assert.deepEqual(env.logs.filter(line => line.startsWith('Cannot read the ignore store')), [
    `Cannot read the ignore store ${store}; continuing with no ignored findings`,
  ])
})

test('an unreadable store warns again only after a later read succeeds', async () => {
  const store = storePath(config.repo, join('/elsewhere', 'npm-dep-autopilot'))
  let reads = 0
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical'), finding('2', [WITHIN], 'critical'), finding('3', [WITHIN], 'critical')] },
    loadIgnores: async () => {
      reads += 1
      return { entries: [], unreadable: reads !== 2, path: store }
    },
  })

  assert.equal(await env.run(), 'done')
  assert.ok(reads >= 3)
  assert.deepEqual(env.logs.filter(line => line.startsWith('Cannot read the ignore store')), [
    `Cannot read the ignore store ${store}; continuing with no ignored findings`,
    `Cannot read the ignore store ${store}; continuing with no ignored findings`,
  ])
})

test('the loaded ignores are recorded once per cycle and again when they change', async () => {
  let reads = 0
  const env = makeEnv({
    rows: { web: [finding('1'), finding('22')] },
    loadIgnores: async () => {
      reads += 1
      return { entries: reads > 2 ? [stored('web', 'a1b2c3d')] : [], unreadable: false }
    },
  })
  const lines = []

  await runDebug(true, { stderr: { write: line => lines.push(line) } }, env.run)

  assert.deepEqual(lines.filter(line => line.includes(' ignores ')), [
    '[npm-dep-autopilot debug] ignores none\n',
    '[npm-dep-autopilot debug] ignores web:a1b2c3d addedAt=2026-11-13T09:12:04.000Z\n',
    '[npm-dep-autopilot debug] ignores web:a1b2c3d addedAt=2026-11-13T09:12:04.000Z\n',
  ])
})

test('a restart clears runtime skips but not ignores', async () => {
  const env = makeEnv({
    rows: { web: [finding('1', [WITHIN], 'critical'), finding(IGNORED_ID, [WITHIN], 'critical')] },
    newCommits: [true, false],
    rebase: [false],
    loadIgnores: async () => ({ entries: [stored('web', 'a1b2c3d')], unreadable: false }),
  })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(upgrades(env.events), ['upgrade:web:1', 'upgrade:web:1'])
})

test('a project with an empty module publishes deps: titles and deps/ branches', async () => {
  const noModule = { module: '', path: '/r/app', relativePath: 'app', gitCommitArgs: [] }
  const env = makeEnv({ rows: { '': [finding('1', [WITHIN], 'critical')] }, runConfig: { ...config, projects: [noModule] } })

  await env.run()

  assert.equal(env.created[0].branch, 'deps/pkg1-1.0.1')
  assert.equal(env.created[0].title, 'deps: bump pkg1 from 1.0.0 to 1.0.1')
})

const stalePr = { number: 1, headRefName: 'deps/web/a', url: 'u1' }
const currentPr = { number: 2, headRefName: 'deps/web/b', url: 'u2' }
const closeComment = 'Closed by npm-dep-autopilot: this branch is behind main. A new pull request will be planned from the current main.'

test('a stale PR is closed and a work cycle starts without waiting', async () => {
  const env = makeEnv({ openPrs: [[stalePr], []], based: { 'deps/web/a': false } })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(env.closed, [{ number: 1, comment: closeComment }])
  assert.deepEqual(env.sleeps, [])
  assert.ok(env.logs.includes('Closed stale PR u1: deps/web/a is behind main'))
  assert.equal(env.events.filter(event => event === 'syncDefault').length, 2)
  assert.ok(env.events.indexOf('close:1') < env.events.lastIndexOf('syncDefault'))
  assert.ok(env.events.lastIndexOf('syncDefault') < env.events.indexOf('createWorkBranch'))
})

test('a current PR is polled, not closed', async () => {
  const env = makeEnv({ openPrs: [[currentPr], [currentPr], []] })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(env.closed, [])
  assert.deepEqual(env.sleeps, [60000, 60000])
})

test('a PR that falls behind while polling is closed at that poll', async () => {
  const env = makeEnv({ openPrs: [[stalePr]], based: { 'deps/web/a': [true, false] } })

  assert.equal(await env.run(), 'done')
  assert.equal(env.closed.length, 1)
  assert.deepEqual(env.sleeps, [60000])
})

test('only stale PRs are closed and the wait continues for current ones', async () => {
  const env = makeEnv({ openPrs: [[stalePr, currentPr], [currentPr], []], based: { 'deps/web/a': false } })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(env.events.filter(event => event.startsWith('close:')), ['close:1'])
  assert.deepEqual(env.sleeps, [60000, 60000])
})

test('a PR whose branch is missing is not closed', async () => {
  const env = makeEnv({ openPrs: [[stalePr], []], based: { 'deps/web/a': null } })

  assert.equal(await env.run(), 'done')
  assert.deepEqual(env.closed, [])
  assert.deepEqual(env.sleeps, [60000])
})

test('a fetch is done before every PR list poll', async () => {
  const env = makeEnv({ openPrs: [[currentPr], []] })

  await env.run()
  const polls = env.events.flatMap((event, index) => (event === 'openPrs' ? [index] : []))
  assert.equal(polls.length, 2)
  for (const index of polls) assert.equal(env.events[index - 1], 'fetch')
})

test('five consecutive close failures are fatal', async () => {
  const env = makeEnv({ openPrs: [[stalePr]], based: { 'deps/web/a': false }, closeFails: Array.from({ length: 5 }, () => new Error('denied')) })

  await assert.rejects(env.run(), { code: 'GH_UNAVAILABLE' })
  assert.equal(env.sleeps.length, 4)
  assert.equal(env.events.includes('createWorkBranch'), false)
})

test('a single close failure is retried', async () => {
  const env = makeEnv({ openPrs: [[stalePr]], based: { 'deps/web/a': false }, closeFails: [new Error('denied')] })

  assert.equal(await env.run(), 'done')
  assert.equal(env.closed.length, 1)
  assert.deepEqual(env.events.filter(event => event.startsWith('close:')), ['close:1', 'close:1'])
})

test('the deadline during a close returns deadline', async () => {
  const env = makeEnv({ openPrs: [[stalePr]], based: { 'deps/web/a': false }, closeFails: [new DeadlineReached()] })

  assert.equal(await env.run(), 'deadline')
  assert.deepEqual(env.sleeps, [])
})
