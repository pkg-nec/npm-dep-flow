import assert from 'node:assert/strict'
import test from 'node:test'
import { AutopilotError } from '../src/errors.js'
import { createTools } from '../src/tools.js'
import { plannerRow, upgradeReport } from './helpers/fixtures.js'

const project = { module: 'web', path: '/repo/apps/web', gitCommitArgs: ['--no-verify'] }

function fakeRun(result) {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    return typeof result === 'function' ? result(command, args) : result
  }
  return { run, calls }
}

const ok = body => ({ code: 0, stdout: JSON.stringify(body), stderr: '' })

test('plan runs the planner with JSON output in the repo', async () => {
  const { run, calls } = fakeRun(ok({ schemaVersion: 3, rows: [plannerRow()] }))
  const rows = await createTools({ run, repo: '/repo' }).plan(project)

  assert.equal(rows.length, 1)
  assert.equal(calls[0].command, 'npm-dep-upgrade-plan')
  assert.deepEqual(calls[0].args, ['/repo/apps/web', '--format', 'json'])
  assert.equal(calls[0].options.cwd, '/repo')
  assert.equal(calls[0].options.cmdShim, true)
})

test('upgrade passes module, commit args and JSON format', async () => {
  const { run, calls } = fakeRun(ok(upgradeReport()))
  const report = await createTools({ run, repo: '/repo' }).upgrade(project, 'abc')

  assert.equal(report.package, 'brace-expansion')
  assert.equal(calls[0].command, 'npm-dep-upgrade')
  assert.deepEqual(calls[0].args, ['/repo/apps/web', 'abc', '--module', 'web', '--git-commit-arg=--no-verify', '--format', 'json'])
})

test('upgrade omits --git-commit-arg when none are configured', async () => {
  const { run, calls } = fakeRun(ok(upgradeReport()))
  await createTools({ run, repo: '/repo' }).upgrade({ ...project, gitCommitArgs: [] }, 'abc')

  assert.deepEqual(calls[0].args, ['/repo/apps/web', 'abc', '--module', 'web', '--format', 'json'])
})

test('a non-zero exit throws TOOL_FAILED with stderr', async () => {
  const { run } = fakeRun({ code: 1, stdout: '', stderr: 'boom' })
  await assert.rejects(createTools({ run, repo: '/repo' }).plan(project), (error) => {
    assert.ok(error instanceof AutopilotError)
    assert.equal(error.code, 'TOOL_FAILED')
    assert.match(error.message, /boom/)
    return true
  })
})

test('invalid JSON throws TOOL_OUTPUT', async () => {
  const { run } = fakeRun({ code: 0, stdout: 'not json', stderr: '' })
  await assert.rejects(createTools({ run, repo: '/repo' }).plan(project), { code: 'TOOL_OUTPUT' })
})

test('schema version 2 throws TOOL_OUTPUT', async () => {
  const { run } = fakeRun(ok({ schemaVersion: 2, rows: [] }))
  await assert.rejects(createTools({ run, repo: '/repo' }).plan(project), { code: 'TOOL_OUTPUT' })
})

test('upgrade omits --module for an empty module name', async () => {
  const { run, calls } = fakeRun(ok(upgradeReport()))
  await createTools({ run, repo: '/repo' }).upgrade({ ...project, module: '' }, 'abc')

  assert.deepEqual(calls[0].args, ['/repo/apps/web', 'abc', '--git-commit-arg=--no-verify', '--format', 'json'])
})
