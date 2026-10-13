import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

let runNpmDepPaths
try {
  ({ runNpmDepPaths } = await import('../src/dep-paths.js'))
} catch {}

function summary(selector = 'brace-expansion') {
  return {
    schemaVersion: 2,
    project: { name: 'fixture', version: '1.0.0' },
    selector,
    results: [{
      package: selector,
      version: '5.0.9',
      requirements: [{
        declaredRequirement: '^5.0.5',
        directDependents: [{
          name: 'minimatch',
          version: '10.2.5',
          location: 'node_modules/minimatch',
          targetLocation: 'node_modules/brace-expansion',
          type: 'dependencies',
          requestedName: selector,
        }],
      }],
    }],
  }
}

function fakeSpawn(responses, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const response = responses.shift()
    queueMicrotask(() => {
      if (response.error) return child.emit('error', response.error)
      child.stdout.end(response.stdout ?? '')
      child.stderr.end(response.stderr ?? '')
      child.emit('close', response.code ?? 0)
    })
    return child
  }
}

if (typeof runNpmDepPaths !== 'function') {
  test('exports the npm-dep-paths CLI adapter', () => {
    assert.equal(typeof runNpmDepPaths, 'function')
  })
} else {
test('runs the standalone CLI with argv and a project cwd on Unix', async () => {
  const calls = []
  const root = '/tmp/project $(touch unexpected) with spaces'
  const response = summary()
  assert.deepEqual(await runNpmDepPaths(root, 'brace-expansion', fakeSpawn([
    { stdout: JSON.stringify(response) },
  ], calls), 'linux'), response)
  assert.deepEqual(calls, [{
    command: 'npm-dep-paths',
    args: ['.', 'brace-expansion', '--format', 'json'],
    options: { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
})

test('uses the Windows command shim without putting the project path in shell text', async () => {
  const calls = []
  const root = 'C:\\Projects\\my app & scripts'
  const response = summary()
  assert.deepEqual(await runNpmDepPaths(root, 'brace-expansion', fakeSpawn([
    { stdout: JSON.stringify(response) },
  ], calls), 'win32'), response)
  assert.deepEqual(calls, [{
    command: 'npm-dep-paths.cmd . brace-expansion --format json',
    args: [],
    options: { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
  assert.equal(calls[0].command.includes(root), false)
})

test('preserves scoped package selectors', async () => {
  const calls = []
  const response = summary('@scope/brace-expansion')
  const result = await runNpmDepPaths('/project', '@scope/brace-expansion', fakeSpawn([
    { stdout: JSON.stringify(response) },
  ], calls), 'linux')
  assert.equal(result.selector, '@scope/brace-expansion')
  assert.deepEqual(calls[0].args, ['.', '@scope/brace-expansion', '--format', 'json'])
})

test('rejects shell metacharacters in a package selector before spawning', async () => {
  const calls = []
  await assert.rejects(
    runNpmDepPaths('/project', 'brace-expansion & touch bad', fakeSpawn([], calls), 'win32'),
    /invalid package name/i,
  )
  assert.equal(calls.length, 0)
})

for (const response of [
  { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) },
  { code: 1, stderr: 'unsupported project' },
  { code: 0, stdout: '{not json' },
  { code: 0, stdout: JSON.stringify({ ...summary(), schemaVersion: 1 }) },
  { code: 0, stdout: JSON.stringify({ ...summary(), selector: 'other' }) },
  { code: 0, stdout: JSON.stringify({ ...summary(), results: [{ package: 'brace-expansion', version: 3 }] }) },
  { code: 0, stdout: JSON.stringify({ ...summary(), results: [{
    package: 'brace-expansion', version: '5.0.9', requirements: [{
      declaredRequirement: '^5', directDependents: [{ name: 'parent' }],
    }],
  }] }) },
]) {
  test(`rejects an unusable npm-dep-paths response: ${response.error?.message ?? response.stderr ?? response.stdout.slice(0, 32)}`, async () => {
    const calls = []
    await assert.rejects(runNpmDepPaths('/project', 'brace-expansion', fakeSpawn([response], calls)))
    assert.equal(calls.length, 1)
  })
}
}
