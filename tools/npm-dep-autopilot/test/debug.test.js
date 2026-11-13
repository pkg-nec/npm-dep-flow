import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { debugAction, debugLog, debugSpawn, runDebug } from '../src/debug.js'

function capture() {
  let output = ''
  return {
    stderr: {
      write(chunk) {
        output += chunk
      },
    },
    get output() {
      return output
    },
  }
}

function completed(command, args, options) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  queueMicrotask(() => {
    child.stderr.end('[npm-dep-upgrade-plan debug] cache hit\nordinary child output\n')
    child.emit('close', 0)
  })
  child.actual = { command, args, options }
  return child
}

const closed = child => new Promise(resolve => child.on('close', resolve))

test('debug lines carry the tool prefix and paired start and end records', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    const child = debugSpawn(spawn, process.execPath, ['-e', 'process.stdout.write(process.env.DEBUG_TEST_PRIVATE);process.exit(3)'], { cwd: process.cwd(), env: { ...process.env, DEBUG_TEST_PRIVATE: 'PRIVATE_OUTPUT' } })
    await closed(child)
  })

  const lines = io.output.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\[npm-dep-autopilot debug\] start \d+:1 process \{"command":".*","args":\[.*\],"cwd":".*"\}$/)
  assert.match(lines[1], /^\[npm-dep-autopilot debug\] end \d+:1 process exit=3 duration=\d+ms$/)
  assert.doesNotMatch(io.output, /PRIVATE_OUTPUT/)
})

test('debug preserves real arguments but redacts credentials from diagnostics', async () => {
  const io = capture()
  const args = ['--token=https://example.test/URL_TOKEN_VALUE', '--token', 'TOKEN_SECRET', '--registry=https://user:PASS_SECRET@example.test/?access_token=QUERY_SECRET', '//example.test/:_authToken=AUTH_SECRET']
  await runDebug(true, io, async () => {
    const child = debugSpawn(completed, 'gh', args, { cwd: process.cwd() })
    assert.deepEqual(child.actual.args, args)
    await closed(child)
  })

  assert.match(io.output, /REDACTED/)
  assert.doesNotMatch(io.output, /URL_TOKEN_VALUE|TOKEN_SECRET|PASS_SECRET|QUERY_SECRET|AUTH_SECRET/)
})

test('debug logs synchronous and asynchronous launch errors once', async () => {
  const io = capture()
  await runDebug(true, io, async () => {
    assert.throws(() => debugSpawn(() => {
      throw Object.assign(new Error('secret'), { code: 'EACCES' })
    }, 'git', [], {}))
    await closed(debugSpawn(spawn, 'npm-dep-debug-no-such-command', [], {}))
  })

  assert.match(io.output, /error=EACCES/)
  assert.match(io.output, /error=ENOENT/)
  assert.equal((io.output.match(/end /g) || []).length, 2)
  assert.doesNotMatch(io.output, /secret/)
})

for (const windows of [false, true]) {
  for (const sibling of ['npm-dep-upgrade-plan', 'npm-dep-upgrade']) {
    test(`debug propagates to ${sibling} and relays only debug lines (${windows ? 'Windows' : 'Unix'})`, async () => {
      const io = capture()
      await runDebug(true, io, async () => {
        const child = debugSpawn(completed, windows ? `${sibling}.cmd . --format json` : sibling, windows ? [] : ['.', '--format', 'json'], { shell: windows, cwd: process.cwd() })
        if (windows) assert.match(child.actual.command, / --debug$/)
        else assert.deepEqual(child.actual.args, ['.', '--format', 'json', '--debug'])
        assert.equal(child.actual.options.env.NPM_DEP_FLOW_DEBUG, '1')
        await closed(child)
      })

      assert.match(io.output, /^\[npm-dep-upgrade-plan debug\] cache hit$/m)
      assert.doesNotMatch(io.output, /ordinary child output/)
    })
  }
}

test('git and gh get the environment flag but never a --debug argument', async () => {
  await runDebug(true, capture(), async () => {
    for (const command of ['git', 'gh']) {
      const child = debugSpawn(completed, command, ['status'], {})
      assert.deepEqual(child.actual.args, ['status'])
      await closed(child)
    }
  })
})

test('debug is scoped per invocation and disabled mode leaves launches untouched', async () => {
  const enabled = capture()
  const disabled = capture()
  await Promise.all([
    runDebug(true, enabled, async () => {
      await Promise.resolve()
      await closed(debugSpawn(completed, 'git', ['--version'], {}))
    }),
    runDebug(false, disabled, async () => {
      const child = debugSpawn(completed, 'npm-dep-upgrade', ['--version'], {})
      assert.deepEqual(child.actual.args, ['--version'])
      assert.equal(child.actual.options.env, undefined)
      await closed(child)
    }),
  ])

  assert.match(enabled.output, /start/)
  assert.equal(disabled.output, '')
})

function withEnv(t, value) {
  const previous = process.env.NPM_DEP_FLOW_DEBUG
  if (value === undefined) delete process.env.NPM_DEP_FLOW_DEBUG
  else process.env.NPM_DEP_FLOW_DEBUG = value
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_DEP_FLOW_DEBUG
    else process.env.NPM_DEP_FLOW_DEBUG = previous
  })
}

test('an inherited NPM_DEP_FLOW_DEBUG=1 enables debug when no explicit setting is given', async (t) => {
  withEnv(t, '1')
  const io = capture()
  await runDebug(undefined, io, async () => {
    await closed(debugSpawn(completed, 'git', ['fetch'], {}))
  })

  assert.match(io.output, /\[npm-dep-autopilot debug\] start/)
})

test('explicit disable prevents inherited debug from reaching sibling processes', async (t) => {
  withEnv(t, '1')
  const io = capture()
  await runDebug(false, io, async () => {
    const child = debugSpawn(completed, 'npm-dep-upgrade', ['--version'], { env: { ...process.env } })
    assert.notEqual(child.actual.options.env.NPM_DEP_FLOW_DEBUG, '1')
    await closed(child)
  })

  assert.equal(io.output, '')
})

test('debugLog and debugAction are silent outside an enabled scope', async (t) => {
  withEnv(t, undefined)
  const io = capture()
  debugLog('outside')
  debugAction('x', {})('done')
  await runDebug(false, io, async () => {
    debugLog('disabled')
  })

  assert.equal(io.output, '')
})

test('a broken diagnostic sink does not break command execution', async () => {
  const io = { stderr: { write() {
    throw new Error('sink closed')
  } } }
  await runDebug(true, io, async () => {
    await closed(debugSpawn(completed, 'git', ['fetch'], {}))
  })
})
