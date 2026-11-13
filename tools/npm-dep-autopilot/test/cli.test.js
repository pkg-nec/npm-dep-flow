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
  assert.equal(rows.length, 6)
  assert.equal(new Set(columns).size, 1)
  assert.equal(columns[0], 2 + longest + 2)
})

test('--version prints the tool version and install directory', async () => {
  const { code, stdout } = await runCli(['--version'])

  assert.equal(code, 0)
  assert.match(stdout, /^npm-dep-autopilot v\d+\.\d+\.\d+\nLocation: /)
  assert.ok(stdout.includes(`Location: ${toolDir}\n`))
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

const readCalls = fakes => readFileSync(path.join(fakes.stateDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const ghCalls = fakes => readFileSync(path.join(fakes.stateDir, 'gh-calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const toolCalls = fakes => readCalls(fakes).filter(call => call.name !== 'gh')

test('--debug logs with the tool prefix, passes debug to planner and upgrade only, and relays their records', { skip: !posix, timeout: 60000 }, async () => {
  const { fakes, repos, env } = scenario()
  const { code, stderr } = await runCli(['--config', await writeConfig(repos), '--debug'], env)
  const planner = toolCalls(fakes).find(call => call.name === 'npm-dep-upgrade-plan')
  const upgrade = toolCalls(fakes).find(call => call.name === 'npm-dep-upgrade' && call.args[1] !== undefined)

  assert.equal(code, 0)
  assert.match(stderr, /^\[npm-dep-autopilot debug\] start \d+:\d+ process \{"command":"git",/m)
  assert.match(stderr, /^\[npm-dep-autopilot debug\] end \d+:\d+ process exit=0 duration=\d+ms$/m)
  assert.match(stderr, /^\[npm-dep-upgrade-plan debug\] fake record$/m)
  assert.match(stderr, /^\[npm-dep-upgrade debug\] fake record$/m)
  assert.equal(stderr.split('\n').some(line => line.startsWith('[debug]')), false)
  assert.ok(planner.args.includes('--debug'))
  assert.ok(upgrade.args.includes('--debug'))
  assert.equal(planner.debugEnv, '1')
  assert.equal(ghCalls(fakes).some(call => call.includes('--debug')), false)
})

test('without debug nothing is logged or passed down', { skip: !posix, timeout: 60000 }, async () => {
  const { fakes, repos, env } = scenario()
  const { code, stderr } = await runCli(['--config', await writeConfig(repos)], env)

  assert.equal(code, 0)
  assert.doesNotMatch(stderr, /debug\]/)
  assert.equal(toolCalls(fakes).some(call => call.args.includes('--debug') || call.debugEnv === '1'), false)
})

test('an inherited NPM_DEP_FLOW_DEBUG=1 enables debug', { skip: !posix, timeout: 60000 }, async () => {
  const { fakes, repos, env } = scenario()
  const { code, stderr } = await runCli(['--config', await writeConfig(repos)], { ...env, NPM_DEP_FLOW_DEBUG: '1' })

  assert.equal(code, 0)
  assert.match(stderr, /^\[npm-dep-autopilot debug\] start /m)
  assert.ok(toolCalls(fakes).some(call => call.name === 'npm-dep-upgrade-plan' && call.args.includes('--debug')))
})

test('--no-debug overrides an inherited NPM_DEP_FLOW_DEBUG=1', { skip: !posix, timeout: 60000 }, async () => {
  const { fakes, repos, env } = scenario()
  const { code, stderr } = await runCli(['--config', await writeConfig(repos), '--no-debug'], { ...env, NPM_DEP_FLOW_DEBUG: '1' })

  assert.equal(code, 0)
  assert.doesNotMatch(stderr, /debug\]/)
  assert.equal(toolCalls(fakes).some(call => call.args.includes('--debug') || call.debugEnv === '1'), false)
})

test('--debug together with --no-debug is an error', async () => {
  const { code, stderr } = await runCli(['--config', 'x.json', '--debug', '--no-debug'])

  assert.equal(code, 1)
  assert.match(stderr, /Repeated debug option/)
})

test('--help lists --no-debug', async () => {
  const { stdout } = await runCli(['--help'])

  assert.match(stdout, /^ {2}--no-debug /m)
})

test('--help starts with the tool name and version, then the usage', async () => {
  const { stdout } = await runCli(['--help'])
  const [title, blank, usage] = stdout.split('\n')

  assert.match(title, /^npm-dep-autopilot v\d+\.\d+\.\d+$/)
  assert.equal(blank, '')
  assert.match(usage, /^Usage: npm-dep-autopilot /)
})

test('--help and --version win over argument validation', async () => {
  for (const args of [['--bogus', '--help'], ['--config', '--help'], ['--help', '--debug', '--no-debug']]) {
    const { code, stdout } = await runCli(args)

    assert.equal(code, 0, args.join(' '))
    assert.match(stdout, /^Usage: npm-dep-autopilot /m)
  }
  for (const args of [['--bogus', '--version'], ['--config', '--version']]) {
    const { code, stdout } = await runCli(args)

    assert.equal(code, 0, args.join(' '))
    assert.match(stdout, /^Location: /m)
  }
})

test('--help takes precedence over --version', async () => {
  const { stdout } = await runCli(['--version', '--help'])

  assert.match(stdout, /^Usage: /m)
})

test('--clear-cache alone clears the chain without config, lock or gh login', { skip: !posix }, async () => {
  const { fakes, env } = scenario()
  writeFileSync(path.join(fakes.stateDir, 'gh-logged-out'), '1')
  const { code, stderr } = await runCli(['--clear-cache'], env)
  const calls = readCalls(fakes)

  assert.equal(code, 0, stderr)
  assert.deepEqual(calls.map(call => [call.name, call.args]), [['npm-dep-upgrade', ['--clear-cache']]])
})

test('--clear-cache with --config clears once at startup, then runs normally', { skip: !posix, timeout: 60000 }, async () => {
  const { fakes, repos, env } = scenario()
  const { code, stderr } = await runCli(['--config', await writeConfig(repos), '--clear-cache'], env)
  const calls = toolCalls(fakes)

  assert.equal(code, 0, stderr)
  assert.deepEqual([calls[0].name, calls[0].args], ['npm-dep-upgrade', ['--clear-cache']])
  assert.equal(calls.filter(call => call.args.includes('--clear-cache')).length, 1)
  assert.ok(calls.findIndex(call => call.name === 'npm-dep-upgrade-plan') > 0)
  assert.ok(ghCalls(fakes).some(call => call[0] === 'pr' && call[1] === 'create'))
})

test('a failing cache clear stops the run with exit 1 before any planning', { skip: !posix }, async () => {
  const { fakes, repos, env } = scenario()
  writeFileSync(path.join(fakes.stateDir, 'clear-fails'), '1')
  const { code, stderr } = await runCli(['--config', await writeConfig(repos), '--clear-cache'], env)

  assert.equal(code, 1)
  assert.match(stderr, /cache is locked/)
  assert.equal(toolCalls(fakes).some(call => call.name === 'npm-dep-upgrade-plan'), false)
})

test('a failing cache clear without config exits 1', { skip: !posix }, async () => {
  const { fakes, env } = scenario()
  writeFileSync(path.join(fakes.stateDir, 'clear-fails'), '1')
  const { code, stderr } = await runCli(['--clear-cache'], env)

  assert.equal(code, 1)
  assert.match(stderr, /cache is locked/)
})

test('a repeated --clear-cache is an error', async () => {
  const { code, stderr } = await runCli(['--clear-cache', '--clear-cache'])

  assert.equal(code, 1)
  assert.match(stderr, /Repeated --clear-cache option/)
})

test('without --config or --clear-cache the config is required', async () => {
  const { code, stderr } = await runCli(['--debug'])

  assert.equal(code, 1)
  assert.match(stderr, /--config/)
})

test('--help lists --clear-cache', async () => {
  const { stdout } = await runCli(['--help'])

  assert.match(stdout, /^ {2}--clear-cache /m)
})
