import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { AutopilotError, DeadlineReached } from '../src/errors.js'
import { runProcess } from '../src/subprocess.js'

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false, spawnError } = {}) {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    if (spawnError) throw spawnError
    const child = new EventEmitter()
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    child.killed = false
    child.pid = 77
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('close', null))
    }
    calls.at(-1).child = child
    if (!hang) {
      setImmediate(() => {
        child.stdout.emit('data', stdout)
        child.stderr.emit('data', stderr)
        child.emit('close', code)
      })
    }
    return child
  }
  return { spawnImpl, calls }
}

test('spawns the command directly on Unix and collects output', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: 'out', stderr: 'err', code: 3 })
  const result = await runProcess('git', ['status'], { cwd: '/repo', spawnImpl, platform: 'linux', cmdShim: true })

  assert.deepEqual(result, { code: 3, stdout: 'out', stderr: 'err' })
  assert.equal(calls[0].command, 'git')
  assert.deepEqual(calls[0].args, ['status'])
  assert.equal(calls[0].options.cwd, '/repo')
  assert.equal(calls[0].options.shell, false)
})

test('runs a .cmd shim through a shell on Windows when cmdShim is set', async () => {
  const { spawnImpl, calls } = fakeSpawn()
  await runProcess('npm-dep-upgrade', ['abc', '--format', 'json'], { spawnImpl, platform: 'win32', cmdShim: true })

  assert.equal(calls[0].command, 'npm-dep-upgrade.cmd abc --format json')
  assert.deepEqual(calls[0].args, [])
  assert.equal(calls[0].options.shell, true)
})

test('spawns directly on Windows without cmdShim', async () => {
  const { spawnImpl, calls } = fakeSpawn()
  await runProcess('git', ['fetch'], { spawnImpl, platform: 'win32' })

  assert.equal(calls[0].command, 'git')
  assert.deepEqual(calls[0].args, ['fetch'])
  assert.equal(calls[0].options.shell, false)
})

test('abort kills the child and rejects with the abort reason', async () => {
  const { spawnImpl, calls } = fakeSpawn({ hang: true })
  const controller = new AbortController()
  const running = runProcess('git', ['fetch'], { spawnImpl, platform: 'linux', signal: controller.signal })
  controller.abort(new DeadlineReached())

  await assert.rejects(running, DeadlineReached)
  assert.equal(calls[0].child.killed, true)
})

test('an already aborted signal rejects without spawning', async () => {
  const { spawnImpl, calls } = fakeSpawn()
  const controller = new AbortController()
  controller.abort(new DeadlineReached())

  await assert.rejects(runProcess('git', [], { spawnImpl, signal: controller.signal }), DeadlineReached)
  assert.equal(calls.length, 0)
})

test('a spawn error rejects', async () => {
  const { spawnImpl } = fakeSpawn({ spawnError: new Error('ENOENT') })
  await assert.rejects(runProcess('git', [], { spawnImpl }), /ENOENT/)
})

test('debug receives start and end records', async () => {
  const { spawnImpl } = fakeSpawn({ code: 0 })
  const lines = []
  await runProcess('git', ['fetch'], { cwd: '/repo', spawnImpl, platform: 'linux', debug: line => lines.push(line) })

  assert.equal(lines.length, 2)
  assert.match(lines[0], /start .*git fetch.*\/repo/)
  assert.match(lines[1], /end .*exit 0/)
})

test('on Unix the child leads its own process group and the group receives SIGTERM', async () => {
  const { spawnImpl, calls } = fakeSpawn({ hang: true })
  const kills = []
  const controller = new AbortController()
  const killProcess = (pid, signal) => {
    kills.push([pid, signal])
    calls[0].child.emit('close', null)
  }
  const running = runProcess('npm-dep-upgrade', ['x'], { spawnImpl, platform: 'linux', signal: controller.signal, killProcess })
  controller.abort(new DeadlineReached())

  await assert.rejects(running, DeadlineReached)
  assert.equal(calls[0].options.detached, true)
  assert.deepEqual(kills, [[-77, 'SIGTERM']])
})

test('escalates to SIGKILL when the group ignores SIGTERM', async () => {
  const { spawnImpl, calls } = fakeSpawn({ hang: true })
  const kills = []
  const controller = new AbortController()
  const killProcess = (pid, signal) => {
    kills.push([pid, signal])
    if (signal === 'SIGKILL') calls[0].child.emit('close', null)
  }
  const running = runProcess('npm-dep-upgrade', [], { spawnImpl, platform: 'linux', signal: controller.signal, killProcess, killGraceMs: 10 })
  controller.abort(new DeadlineReached())

  await assert.rejects(running, DeadlineReached)
  assert.deepEqual(kills, [[-77, 'SIGTERM'], [-77, 'SIGKILL']])
})

test('on Windows the process tree is killed with taskkill', async () => {
  const { spawnImpl, calls } = fakeSpawn({ hang: true })
  const controller = new AbortController()
  const running = runProcess('git', ['fetch'], { spawnImpl, platform: 'win32', signal: controller.signal })
  controller.abort(new DeadlineReached())
  await new Promise(resolve => setImmediate(resolve))
  calls[0].child.emit('close', null)

  await assert.rejects(running, DeadlineReached)
  const kill = calls.find(call => call.command === 'taskkill')
  assert.deepEqual(kill.args, ['/pid', '77', '/T', '/F'])
  assert.notEqual(calls[0].options.detached, true)
})

test('Windows arguments with spaces are quoted for the shell', async () => {
  const { spawnImpl, calls } = fakeSpawn()
  await runProcess('npm-dep-upgrade', ['C:\\my repo\\web', 'abc', '--git-commit-arg=--author=A B'], { spawnImpl, platform: 'win32', cmdShim: true })

  assert.equal(calls[0].command, 'npm-dep-upgrade.cmd "C:\\my repo\\web" abc "--git-commit-arg=--author=A B"')
})

test('Windows arguments with shell metacharacters are refused', async () => {
  const { spawnImpl, calls } = fakeSpawn()

  for (const arg of ['a&b', 'a"b', 'a%b', 'a|b', 'a^b', 'a<b', 'a>b', 'a\nb']) {
    await assert.rejects(runProcess('npm-dep-upgrade', [arg], { spawnImpl, platform: 'win32', cmdShim: true }), AutopilotError)
  }
  assert.equal(calls.length, 0)
})
