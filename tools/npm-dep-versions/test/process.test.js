import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runProcess } from '../src/process.js'

function fakeSpawn(response, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    queueMicrotask(() => {
      if (response.error) {
        child.emit('error', response.error)
        return
      }
      child.stdout.end(response.stdout ?? '')
      child.stderr.end(response.stderr ?? '')
      child.emit('close', response.code ?? 0)
    })
    return child
  }
}

test('process runner uses argv and a project cwd on Unix', async () => {
  const calls = []
  const cwd = '/tmp/project with spaces; no shell expansion'
  const result = await runProcess('npm-dep-audit', ['.', '--format', 'json'], cwd,
    fakeSpawn({ stdout: '{"schemaVersion":2}', stderr: '' }, calls), 'linux')

  assert.deepEqual(calls, [{
    command: 'npm-dep-audit',
    args: ['.', '--format', 'json'],
    options: { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
  assert.deepEqual(result, { code: 0, stdout: '{"schemaVersion":2}', stderr: '' })
})

test('process runner invokes the Windows command shim without putting cwd in shell text', async () => {
  const calls = []
  const cwd = 'C:\\Projects\\my app & scripts'
  const result = await runProcess('npm', ['view', '@scope/pkg', 'versions', '--json'], cwd,
    fakeSpawn({ stdout: '["1.0.0"]' }, calls), 'win32')

  assert.deepEqual(calls, [{
    command: 'npm.cmd view @scope/pkg versions --json',
    args: [],
    options: { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
  assert.equal(calls[0].command.includes(cwd), false)
  assert.deepEqual(result, { code: 0, stdout: '["1.0.0"]', stderr: '' })
})

test('process runner collects both output streams and resolves the exit code', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const spawnImpl = () => child
  const resultPromise = runProcess('tool', [], '/project', spawnImpl, 'linux')
  child.stdout.write('out-')
  child.stderr.write('err-')
  child.stdout.end('done')
  child.stderr.end('done')
  child.emit('close', 7)

  assert.deepEqual(await resultPromise, { code: 7, stdout: 'out-done', stderr: 'err-done' })
})

test('process runner preserves UTF-8 characters split across output chunks', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  const resultPromise = runProcess('tool', [], '/project', () => child, 'linux')

  child.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]))
  child.stdout.end(Buffer.from([0xa9]))
  child.stderr.write(Buffer.from([0x65, 0x72, 0x72, 0xc3]))
  child.stderr.end(Buffer.from([0xa9]))
  child.emit('close', 0)

  assert.deepEqual(await resultPromise, { code: 0, stdout: 'café', stderr: 'erré' })
})

test('process runner rejects a child startup error', async () => {
  const error = Object.assign(new Error('missing command'), { code: 'ENOENT' })
  await assert.rejects(runProcess('missing', [], '/project', fakeSpawn({ error }, []), 'linux'), error)
})
