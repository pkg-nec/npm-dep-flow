import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { AutopilotError } from '../src/errors.js'

async function writeConfig(value, raw = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopilot-config-'))
  const file = path.join(dir, 'config.json')
  await writeFile(file, raw ? value : JSON.stringify(value))
  return { dir, file }
}

const base = () => ({
  repo: 'repo-a',
  defaultBranch: 'main',
  projects: [{ path: 'apps/web', module: 'web' }],
})

async function assertRejects(value, pattern, raw = false) {
  const { file } = await writeConfig(value, raw)
  await assert.rejects(loadConfig(file), (error) => {
    assert.ok(error instanceof AutopilotError)
    assert.match(error.message, pattern)
    return true
  })
}

test('resolves paths against the config directory and applies defaults', async () => {
  const { dir, file } = await writeConfig(base())
  const config = await loadConfig(file)

  assert.equal(config.repo, path.join(dir, 'repo-a'))
  assert.equal(config.defaultBranch, 'main')
  assert.equal(config.pollIntervalSeconds, 60)
  assert.equal(config.deadline, '00:00')
  assert.deepEqual(config.projects, [{
    path: path.join(dir, 'repo-a', 'apps/web'),
    relativePath: path.join('apps', 'web'),
    module: 'web',
    gitCommitArgs: [],
  }])
})

test('keeps explicit settings and absolute repo paths', async () => {
  const { dir, file } = await writeConfig({
    ...base(),
    repo: '/srv/repo-a',
    pollIntervalSeconds: 5,
    deadline: '23:30',
    projects: [{ path: '.', module: 'root', gitCommitArgs: ['--no-verify'] }],
  })
  const config = await loadConfig(file)

  assert.equal(config.repo, path.resolve(dir, '/srv/repo-a'))
  assert.equal(config.pollIntervalSeconds, 5)
  assert.equal(config.deadline, '23:30')
  assert.equal(config.projects[0].path, path.resolve(dir, '/srv/repo-a'))
  assert.deepEqual(config.projects[0].gitCommitArgs, ['--no-verify'])
})

test('rejects an unknown top-level key', () => assertRejects({ ...base(), extra: 1 }, /extra/))
test('rejects an unknown project key', () => assertRejects({ ...base(), projects: [{ path: 'a', module: 'a', extra: 1 }] }, /extra/))
test('rejects a missing repo', () => assertRejects({ defaultBranch: 'main', projects: base().projects }, /repo/))
test('rejects a missing defaultBranch', () => assertRejects({ repo: 'r', projects: base().projects }, /defaultBranch/))
test('rejects missing projects', () => assertRejects({ repo: 'r', defaultBranch: 'main' }, /projects/))
test('rejects empty projects', () => assertRejects({ ...base(), projects: [] }, /projects/))
test('rejects duplicate modules', () => assertRejects({ ...base(), projects: [{ path: 'a', module: 'm' }, { path: 'b', module: 'm' }] }, /module/))
test('rejects duplicate paths', () => assertRejects({ ...base(), projects: [{ path: 'a', module: 'x' }, { path: './a', module: 'y' }] }, /path/))
test('rejects a project path outside the repo', () => assertRejects({ ...base(), projects: [{ path: '../outside', module: 'x' }] }, /outside/))
test('rejects a zero poll interval', () => assertRejects({ ...base(), pollIntervalSeconds: 0 }, /pollIntervalSeconds/))
test('rejects a fractional poll interval', () => assertRejects({ ...base(), pollIntervalSeconds: 1.5 }, /pollIntervalSeconds/))
test('rejects deadline 24:00', () => assertRejects({ ...base(), deadline: '24:00' }, /deadline/))
test('rejects a malformed deadline', () => assertRejects({ ...base(), deadline: '7:5' }, /deadline/))
test('rejects non-string gitCommitArgs', () => assertRejects({ ...base(), projects: [{ path: 'a', module: 'a', gitCommitArgs: [1] }] }, /gitCommitArgs/))
test('rejects gitCommitArgs that is not an array', () => assertRejects({ ...base(), projects: [{ path: 'a', module: 'a', gitCommitArgs: '--no-verify' }] }, /gitCommitArgs/))
test('rejects invalid JSON', () => assertRejects('{nope', /JSON/, true))

for (const bad of [' ', 'has space', 'a..b', 'x.lock', '-lead', 'a/b', 'a~b']) {
  test(`rejects the unsafe module name ${JSON.stringify(bad)}`, () => assertRejects({ ...base(), projects: [{ path: 'a', module: bad }] }, /module/))
}

test('accepts an empty module name', async () => {
  const { file } = await writeConfig({ ...base(), projects: [{ path: 'a', module: '' }] })
  const config = await loadConfig(file)

  assert.equal(config.projects[0].module, '')
})

test('rejects a project without a module key', () => assertRejects({ ...base(), projects: [{ path: 'a' }] }, /module/))
test('rejects two projects with an empty module', () => assertRejects({ ...base(), projects: [{ path: 'a', module: '' }, { path: 'b', module: '' }] }, /module/))
test('rejects a non-string module', () => assertRejects({ ...base(), projects: [{ path: 'a', module: 1 }] }, /module/))

test('rejects an unreadable file', async () => {
  await assert.rejects(loadConfig('/nonexistent/config.json'), AutopilotError)
})
