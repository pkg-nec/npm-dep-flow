import assert from 'node:assert/strict'
import test from 'node:test'
import { DeadlineReached } from '../src/errors.js'
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

function makeEnv({ rows = {}, openPrs = [[]], upgrade, rebase = [true], newCommits = [false], dirty = false, onWork = false, sleep, commits = {}, strategies = {}, keepFindings = false } = {}) {
  const events = []
  const fixed = new Set()
  const prQueue = [...openPrs]
  const rebaseQueue = [...rebase]
  const newQueue = [...newCommits]
  const state = { commits: 0, dirty }
  const created = []

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
    async subjectsSince() {
      return ['subject one']
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
      if (sleep) await sleep(sleeps.length)
    },
  }

  return { events, created, sleeps, run: () => runAutopilot({ config, gh, git, tools, deadline, log: () => {} }) }
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
  assert.equal(env.created[0].body, '- subject one')
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
