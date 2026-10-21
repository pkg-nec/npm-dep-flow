import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runDebug, debugSpawn, debugAction } from '../src/debug.js'

function capture() {
  let output = ''
  return { stderr: { write(chunk) {
    output += chunk
  } }, get output() {
    return output
  } }
}
function completed(command, args, options) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  queueMicrotask(() => {
    child.stderr.end('[npm-dep-paths debug] cache hit\nordinary child output\n')
    child.emit('close', 0)
  })
  child.actual = { command, args, options }
  return child
}

test('debug logs command boundaries, cwd and failure status without child output', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    const child = debugSpawn(spawn, process.execPath, ['-e', 'process.stdout.write(process.env.DEBUG_TEST_PRIVATE);process.exit(3)'], { cwd: process.cwd(), env: { ...process.env, DEBUG_TEST_PRIVATE: 'PRIVATE_OUTPUT' } })
    await new Promise(resolve => child.on('close', resolve))
  })
  assert.match(io.output, /start.*cwd/)
  assert.match(io.output, /exit=3.*duration=\d+ms/)
  assert.doesNotMatch(io.output, /PRIVATE_OUTPUT/)
})

test('debug preserves real arguments but redacts credentials from diagnostics', async () => {
  const io = capture()
  const args = ['--token=https://example.test/URL_TOKEN_VALUE', '--token', 'TOKEN_SECRET', '--registry=https://user:PASS_SECRET@example.test/?access_token=QUERY_SECRET', '//example.test/:_authToken=AUTH_SECRET', '-c', 'http.extraHeader=Authorization: Bearer HEADER_SECRET']
  await runDebug(true, io, async () => {
    const child = debugSpawn(completed, 'npm', args, { cwd: process.cwd() })
    assert.deepEqual(child.actual.args, args)
    await new Promise(resolve => child.on('close', resolve))
  })
  assert.match(io.output, /REDACTED/)
  assert.doesNotMatch(io.output, /URL_TOKEN_VALUE|TOKEN_SECRET|PASS_SECRET|QUERY_SECRET|AUTH_SECRET|HEADER_SECRET/)
})

test('debug logs synchronous and asynchronous launch errors once', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    assert.throws(() => debugSpawn(() => {
      throw Object.assign(new Error('secret'), { code: 'EACCES' })
    }, 'npm', [], {}))
    const child = debugSpawn(spawn, 'npm-dep-debug-no-such-command', [], {})
    await new Promise(resolve => child.on('close', resolve))
  })
  assert.match(io.output, /error=EACCES/)
  assert.match(io.output, /error=ENOENT/)
  assert.equal((io.output.match(/end /g) || []).length, 2)
  assert.doesNotMatch(io.output, /secret/)
})

for (const windows of [false, true]) {
  test(`debug propagates to siblings and relays only debug lines (${windows ? 'Windows' : 'Unix'})`, async () => {
    const io = capture()
    await runDebug(true, io, async () => {
      const child = debugSpawn(completed, windows ? 'npm-dep-paths.cmd . pkg --format json' : 'npm-dep-paths', windows ? [] : ['.', 'pkg', '--format', 'json'], { shell: windows, cwd: process.cwd() })
      if (windows) assert.match(child.actual.command, / --debug$/)
      else assert.deepEqual(child.actual.args, ['.', 'pkg', '--format', 'json', '--debug'])
      assert.equal(child.actual.options.env.NPM_DEP_FLOW_DEBUG, '1')
      await new Promise(resolve => child.on('close', resolve))
    })
    assert.match(io.output, /\[npm-dep-paths debug\] cache hit/)
    assert.doesNotMatch(io.output, /ordinary child output/)
  })
}

test('debug is scoped per invocation and disabled mode leaves launches untouched', async () => {
  const enabled = capture(), disabled = capture()
  await Promise.all([runDebug(true, enabled, async () => {
    await Promise.resolve()
    const child = debugSpawn(completed, 'npm', ['--version'], {})
    await new Promise(resolve => child.on('close', resolve))
  }), runDebug(false, disabled, async () => {
    const child = debugSpawn(completed, 'npm-dep-paths', ['--version'], {})
    assert.deepEqual(child.actual.args, ['--version'])
    assert.equal(child.actual.options.env, undefined)
    await new Promise(resolve => child.on('close', resolve))
  })])
  assert.match(enabled.output, /start/)
  assert.equal(disabled.output, '')
})

test('direct request diagnostics contain method, sanitized URL and outcome', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    const finish = debugAction('http', { method: 'POST', url: 'https://user:HTTP_SECRET@example.test/security?token=QUERY_SECRET' })
    finish('status=200')
  })
  assert.match(io.output, /start.*POST.*example.test/)
  assert.match(io.output, /end.*status=200.*duration=\d+ms/)
  assert.doesNotMatch(io.output, /HTTP_SECRET|QUERY_SECRET/)
})

test('debug redacts credentials in rendered Windows commands and continues after a broken sink', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    const child = debugSpawn(completed, 'npm.cmd view pkg --token SHELL_SECRET --registry=https://user:URL_SECRET@example.test', [], { shell: true })
    await new Promise(resolve => child.on('close', resolve))
  })
  assert.doesNotMatch(io.output, /SHELL_SECRET|URL_SECRET/)
  await runDebug(true, { stderr: { write() {
    throw new Error('closed')
  } } }, async () => {
    const child = debugSpawn(completed, 'npm', ['--version'], {})
    await new Promise(resolve => child.on('close', resolve))
  })
})

test('debug redacts URL credentials containing quotes or whitespace', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    for (const quote of ['\'', '"', ' ', '\t', '\n']) {
      debugAction('http', { url: `https://user:abc${quote}PASSWORD_SECRET@example.test/security` })('status=200')
      debugAction('http', { url: `https://example.test/security?token=abc${quote}QUERY_SECRET` })('status=200')
      const child = debugSpawn(completed, 'npm', [`--registry=https://abc${quote}USERNAME_SECRET:pass@example.test/`], {})
      await new Promise(resolve => child.on('close', resolve))
      const windows = debugSpawn(completed, `npm.cmd view pkg --registry=https://user:abc${quote}SHELL_VALUE@example.test/ --json`, [], { shell: true })
      await new Promise(resolve => windows.on('close', resolve))
    }
  })
  assert.doesNotMatch(io.output, /PASSWORD_SECRET|USERNAME_SECRET|QUERY_SECRET|SHELL_VALUE/)
  assert.match(io.output, /REDACTED/)
})

test('explicit debug disable prevents inherited debug from reaching sibling processes', async (t) => {
  const previous = process.env.NPM_DEP_FLOW_DEBUG
  process.env.NPM_DEP_FLOW_DEBUG = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_DEP_FLOW_DEBUG
    else process.env.NPM_DEP_FLOW_DEBUG = previous
  })
  const io = capture()
  await runDebug(false, io, async () => {
    const child = debugSpawn(completed, 'npm-dep-paths', ['--version'], { env: { ...process.env } })
    assert.notEqual(child.actual.options.env.NPM_DEP_FLOW_DEBUG, '1')
    await new Promise(resolve => child.on('close', resolve))
  })
  assert.equal(io.output, '')
})

test('upgrade relays version-catalog debug lines from nested planner', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    const fake = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        child.stderr.end('[npm-dep-versions debug] cache hit catalog\n')
        child.emit('close', 0)
      })
      return child
    }
    const child = debugSpawn(fake, 'npm-dep-upgrade-plan', ['.', '--format', 'json'], {})
    await new Promise(resolve => child.on('close', resolve))
  })
  assert.match(io.output, /\[npm-dep-versions debug\] cache hit catalog/)
})
