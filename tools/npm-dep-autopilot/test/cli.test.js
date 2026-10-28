import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireLock } from '../src/lock.js'
import { installFakes } from './helpers/fake-bin.js'
import { createRepos, git } from './helpers/repo.js'

const toolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bin = path.join(toolDir, 'bin', 'npm-dep-autopilot.js')
const posix = process.platform !== 'win32'

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
}

function scenario() {
  const fakes = installFakes()
  const repos = createRepos()
  const env = {
    PATH: `${fakes.bin}${path.delimiter}${process.env.PATH}`,
    FAKE_STATE_DIR: fakes.stateDir,
    XDG_RUNTIME_DIR: fakes.runtimeDir,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  return { fakes, repos, env }
}

async function writeConfig(repos, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopilot-cli-'))
  const file = path.join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({
    repo: repos.clone,
    defaultBranch: 'main',
    pollIntervalSeconds: 1,
    projects: [{ path: '.', module: 'web', gitCommitArgs: ['--no-verify'] }],
    ...overrides,
  }))
  return file
}

test('--help aligns option descriptions to one column', async () => {
  const { code, stdout } = await runCli(['--help'])
  const rows = stdout.split('\n').filter(line => /^ {2}--/.test(line)).map(line => line.match(/^ {2}(--\S+(?: <\S+>)?)( {2,})\S/))
  const columns = rows.map(match => 2 + match[1].length + match[2].length)
  const longest = Math.max(...rows.map(match => match[1].length))

  assert.equal(code, 0)
  assert.equal(rows.length, 4)
  assert.equal(new Set(columns).size, 1)
  assert.equal(columns[0], 2 + longest + 2)
})

test('--version prints the tool version and install directory', async () => {
  const { code, stdout } = await runCli(['--version'])

  assert.equal(code, 0)
  assert.match(stdout, /^npm-dep-autopilot \d+\.\d+\.\d+/)
  assert.ok(stdout.includes(toolDir))
})

test('a missing --config is an error', async () => {
  const { code, stderr } = await runCli([])

  assert.equal(code, 1)
  assert.match(stderr, /--config/)
})

test('an invalid config exits 1 before any work', { skip: !posix }, async () => {
  const { fakes, repos, env } = scenario()
  const file = await writeConfig(repos, { projects: [] })
  const { code, stderr } = await runCli(['--config', file], env)

  assert.equal(code, 1)
  assert.match(stderr, /projects/)
  assert.equal(existsSync(path.join(fakes.stateDir, 'gh-calls.log')), false)
})

test('a second instance exits 0 without calling gh', { skip: !posix }, async () => {
  const { fakes, repos, env } = scenario()
  const file = await writeConfig(repos)
  const lock = await acquireLock({ repo: repos.clone, dir: fakes.runtimeDir })
  const { code, stdout } = await runCli(['--config', file], env)

  assert.ok(lock)
  assert.equal(code, 0)
  assert.match(stdout, /already running/)
  assert.equal(existsSync(path.join(fakes.stateDir, 'gh-calls.log')), false)
})

test('no gh login exits 1', { skip: !posix }, async () => {
  const { fakes, repos, env } = scenario()
  writeFileSync(path.join(fakes.stateDir, 'gh-logged-out'), '1')
  const { code, stderr } = await runCli(['--config', await writeConfig(repos)], env)

  assert.equal(code, 1)
  assert.match(stderr, /login/)
})

test('fixes a critical finding, opens a labelled PR and finishes', { skip: !posix, timeout: 60000 }, async () => {
  const { fakes, repos, env } = scenario()
  const { code, stderr } = await runCli(['--config', await writeConfig(repos)], env)
  const calls = readFileSync(path.join(fakes.stateDir, 'gh-calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const create = calls.find(call => call[0] === 'pr' && call[1] === 'create')

  assert.equal(code, 0, stderr)
  assert.ok(create)
  assert.ok(create.includes('dependencies'))
  assert.equal(create[create.indexOf('--title') + 1], 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12')
  assert.equal(create[create.indexOf('--head') + 1], 'deps/web/brace-expansion-5.0.12')
  assert.match(git(repos.remote, 'branch', '--list', 'deps/web/brace-expansion-5.0.12'), /brace-expansion-5.0.12/)
})
