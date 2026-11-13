import assert from 'node:assert/strict'
import test from 'node:test'
import { createGh } from '../src/gh.js'

function fakeRun(results) {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    return results.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

test('assertLoggedIn runs gh auth status and rejects with GH_NOT_LOGGED_IN', async () => {
  const { run, calls } = fakeRun([{ code: 1, stdout: '', stderr: 'not logged in' }])
  await assert.rejects(createGh({ run, repo: '/repo' }).assertLoggedIn(), { code: 'GH_NOT_LOGGED_IN' })
  assert.deepEqual(calls[0].args, ['auth', 'status'])
  assert.equal(calls[0].command, 'gh')
  assert.equal(calls[0].options.cwd, '/repo')
  assert.notEqual(calls[0].options.cmdShim, true)
})

test('assertLoggedIn resolves when gh succeeds', async () => {
  const { run } = fakeRun([{ code: 0, stdout: '', stderr: '' }])
  await createGh({ run, repo: '/repo' }).assertLoggedIn()
})

test('currentUser returns the trimmed login', async () => {
  const { run, calls } = fakeRun([{ code: 0, stdout: 'maw\n', stderr: '' }])
  assert.equal(await createGh({ run, repo: '/repo' }).currentUser(), 'maw')
  assert.deepEqual(calls[0].args, ['api', 'user', '--jq', '.login'])
})

test('openPrs lists open dependencies PRs by author', async () => {
  const { run, calls } = fakeRun([{ code: 0, stdout: '[{"number":7,"headRefName":"deps/web/x-1"}]', stderr: '' }])
  const prs = await createGh({ run, repo: '/repo' }).openPrs('maw')

  assert.deepEqual(prs, [{ number: 7, headRefName: 'deps/web/x-1' }])
  assert.deepEqual(calls[0].args, ['pr', 'list', '--state', 'open', '--label', 'dependencies', '--author', 'maw', '--json', 'number,headRefName'])
})

test('openPrs throws on failure', async () => {
  const { run } = fakeRun([{ code: 1, stdout: '', stderr: 'network' }])
  await assert.rejects(createGh({ run, repo: '/repo' }).openPrs('maw'), { code: 'GH_FAILED' })
})

test('createPr passes branch, title, body, base and the dependencies label', async () => {
  const { run, calls } = fakeRun([{ code: 0, stdout: 'https://github.com/o/r/pull/9\n', stderr: '' }])
  const url = await createGh({ run, repo: '/repo' }).createPr({ branch: 'deps/web/x-1', title: 'deps(web): t', body: 'b', base: 'main' })

  assert.equal(url, 'https://github.com/o/r/pull/9')
  assert.deepEqual(calls[0].args, ['pr', 'create', '--base', 'main', '--head', 'deps/web/x-1', '--title', 'deps(web): t', '--body', 'b', '--label', 'dependencies'])
})

test('ensureLabel tolerates an existing label but not other failures', async () => {
  const exists = fakeRun([{ code: 1, stdout: '', stderr: 'label with name "dependencies" already exists' }])
  await createGh({ run: exists.run, repo: '/repo' }).ensureLabel()
  assert.deepEqual(exists.calls[0].args, ['label', 'create', 'dependencies'])

  const broken = fakeRun([{ code: 1, stdout: '', stderr: 'permission denied' }])
  await assert.rejects(createGh({ run: broken.run, repo: '/repo' }).ensureLabel(), { code: 'GH_FAILED' })
})
