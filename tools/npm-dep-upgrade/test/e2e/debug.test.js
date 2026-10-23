import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject } from './helpers/project.js'
import { command } from './helpers/commands.js'
import { direct } from './fixtures/catalog.js'
import { assertSuccess } from './helpers/runner.js'

test('debug follows the real CLI chain, preserves caches and logs upgrade HTTP, installs and hooks', async (t) => {
  const f = await createProject(direct(), {}, t)
  const first = await command(f, 'npm-dep-upgrade-plan', ['--debug', '--format', 'json'])
  assert.equal(first.code, 0, first.stderr)
  const [row] = JSON.parse(first.stdout).rows
  for (const tool of ['npm-dep-upgrade-plan', 'npm-dep-audit', 'npm-dep-paths', 'npm-dep-versions']) assert.match(first.stderr, new RegExp(`\\[${tool} debug\\]`))
  assert.match(first.stderr, /"args":\["view"|"command":"npm\.cmd view /)
  assert.match(first.stderr, /"args":\["audit"|"command":"npm\.cmd audit /)
  assert.match(first.stderr, /versions.*time.*--json/)
  assert.match(first.stderr, /cache miss/)
  const warm = await command(f, 'npm-dep-upgrade-plan', ['--format', 'json', '--debug'])
  assert.equal(warm.code, 0, warm.stderr)
  assert.deepEqual(JSON.parse(warm.stdout), JSON.parse(first.stdout))
  assert.match(warm.stderr, /cache hit result/)
  assert.doesNotMatch(warm.stderr, /"args":\["(?:view|audit)"|"command":"npm\.cmd (?:view|audit) /)
  const result = await command(f, 'npm-dep-upgrade', [row.id, '--debug', '--format', 'json'])
  await assertSuccess(f, result)
  assert.match(result.stderr, /http.*"method":"POST".*security\/advisories\/bulk/)
  assert.match(result.stderr, /http status=200/)
  assert.match(result.stderr, /"args":\["ci"/)
  assert.match(result.stderr, /"args":\["ci"/)
  assert.match(result.stderr, /"command":"git"/)
  assert.match(result.stderr, /"hook","run"/)
  assert.match(result.stderr, /--prefer-online/)
  assert.match(result.stderr, /cache bypass/)
  for (const tool of ['npm-dep-upgrade', 'npm-dep-upgrade-plan', 'npm-dep-audit', 'npm-dep-paths']) assert.match(result.stderr, new RegExp(`\\[${tool} debug\\]`))
})

test('debug HTTP and npm failures keep stdout empty', async (t) => {
  const f = await createProject(direct(), {}, t)
  const plan = await command(f, 'npm-dep-upgrade-plan', ['--format', 'json'])
  assert.equal(plan.code, 0, plan.stderr)
  const [row] = JSON.parse(plan.stdout).rows
  f.scenario.request = ({ call }) => call.path.endsWith('/advisories/bulk') && call.body['e2e-target']?.includes('6.0.12') ? { status: 503 } : null
  const failed = await command(f, 'npm-dep-upgrade', [row.id, '--debug', '--format', 'json'])
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, '')
  assert.match(failed.stderr, /http error=request-failed/)
  f.scenario.request = ({ call }) => call.path === '/e2e-target' ? { status: 503 } : null
  const npmFailed = await command(f, 'npm-dep-upgrade-plan', ['--debug', '--no-cache', '--format', 'json'])
  assert.equal(npmFailed.code, 1)
  assert.equal(npmFailed.stdout, '')
  assert.match(npmFailed.stderr, /process exit=1/)
  assert.match(npmFailed.stderr, /npm-dep-versions failed/)
})
