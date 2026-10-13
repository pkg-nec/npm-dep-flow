import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fetchReleaseTimes, fetchStableVersions } from '../src/registry.js'

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

test('registry adapter invokes npm view with a scoped name and project cwd on Unix', async () => {
  const calls = []
  const cwd = '/tmp/project with spaces; safe because it is cwd'
  const versions = ['2.0.0', '1.0.0']
  assert.deepEqual(await fetchStableVersions(cwd, '@scope/pkg', fakeSpawn({
    stdout: JSON.stringify(versions),
  }, calls), 'linux'), ['1.0.0', '2.0.0'])
  assert.deepEqual(calls, [{
    command: 'npm',
    args: ['view', '@scope/pkg', 'versions', '--json'],
    options: { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
})

test('registry adapter uses the Windows npm command shim', async () => {
  const calls = []
  const cwd = 'C:\\Projects\\my app & scripts'
  assert.deepEqual(await fetchStableVersions(cwd, 'brace-expansion', fakeSpawn({
    stdout: JSON.stringify(['5.0.9']),
  }, calls), 'win32'), ['5.0.9'])
  assert.deepEqual(calls, [{
    command: 'npm.cmd view brace-expansion versions --json',
    args: [],
    options: { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
  assert.equal(calls[0].command.includes(cwd), false)
})

test('registry adapter filters prereleases and non-semver values, deduplicates, and sorts versions', async () => {
  const calls = []
  const published = [
    '5.0.12', '5.0.9', '5.0.10', '5.0.10', '5.0.11-beta.1', 'latest', 'v5.0.8',
    '1.0.0+build.2', '1.0.0+build.1',
  ]
  assert.deepEqual(await fetchStableVersions('/project', 'brace-expansion', fakeSpawn({
    stdout: JSON.stringify(published),
  }, calls), 'linux'), [
    '1.0.0+build.1', '1.0.0+build.2', '5.0.9', '5.0.10', '5.0.12',
  ])
})

test('registry adapter accepts a scalar JSON string response', async () => {
  assert.deepEqual(await fetchStableVersions('/project', 'brace-expansion', fakeSpawn({
    stdout: JSON.stringify('5.0.12'),
  }, []), 'linux'), ['5.0.12'])
})

test('registry adapter accepts an empty version array', async () => {
  assert.deepEqual(await fetchStableVersions('/project', 'brace-expansion', fakeSpawn({
    stdout: '[]',
  }, []), 'linux'), [])
})

test('registry adapter returns normalized stable release times', async () => {
  const calls = []
  const releaseTimes = await fetchReleaseTimes('/project', 'brace-expansion', fakeSpawn({
    stdout: JSON.stringify({
      created: '2017-01-01T00:00:00.000Z',
      modified: '2026-10-02T00:00:00.000Z',
      '5.0.12': '2026-10-01T12:00:00Z',
      '5.0.13': '2026-02-30T12:00:00.000Z',
      '5.0.14-beta.1': '2026-10-02T12:00:00.000Z',
    }),
  }, calls), 'linux')

  assert.deepEqual([...releaseTimes], [['5.0.12', '2026-10-01T12:00:00.000Z']])
  assert.deepEqual(calls, [{
    command: 'npm',
    args: ['view', 'brace-expansion', 'time', '--json'],
    options: { cwd: '/project', shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
})

test('registry adapter returns an empty release-time map when version dates are absent or invalid', async () => {
  const releaseTimes = await fetchReleaseTimes('/project', 'brace-expansion', fakeSpawn({
    stdout: JSON.stringify({ created: 'invalid', modified: 'invalid', '5.0.12': null }),
  }, []), 'linux')

  assert.deepEqual([...releaseTimes], [])
})

test('registry adapter treats a null time field as unavailable release metadata', async () => {
  const releaseTimes = await fetchReleaseTimes('/project', 'brace-expansion', fakeSpawn({
    stdout: 'null',
  }, []), 'linux')

  assert.deepEqual([...releaseTimes], [])
})

for (const packageName of ['', 'brace-expansion & touch bad', '@scope/name;bad']) {
  test(`registry adapter rejects an unsafe package name before spawning: ${packageName || '(empty)'}`, async () => {
    const calls = []
    await assert.rejects(fetchStableVersions('/project', packageName, fakeSpawn({}, calls), 'win32'), /invalid package name/i)
    assert.equal(calls.length, 0)
  })
}

test('registry adapter rejects invalid JSON without echoing its content', async () => {
  await assert.rejects(
    fetchStableVersions('/project', 'brace-expansion', fakeSpawn({ stdout: '{secret-token' }, []), 'linux'),
    error => /invalid JSON/i.test(error.message) && !error.message.includes('secret-token'),
  )
})

for (const stdout of ['{}', '1', 'null', '["1.0.0", 2]']) {
  test(`registry adapter rejects an invalid JSON response shape: ${stdout}`, async () => {
    await assert.rejects(
      fetchStableVersions('/project', 'brace-expansion', fakeSpawn({ stdout }, []), 'linux'),
      /invalid npm registry response/i,
    )
  })
}

test('registry adapter rejects nonzero npm exits without echoing stderr', async () => {
  await assert.rejects(
    fetchStableVersions('/project', 'brace-expansion', fakeSpawn({ code: 1, stderr: 'secret-token' }, []), 'linux'),
    error => /npm view failed for brace-expansion with exit code 1/.test(error.message) &&
      /package name/.test(error.message) &&
      /registry access/.test(error.message) &&
      !error.message.includes('secret-token'),
  )
})

test('registry adapter gives installation guidance when npm is missing', async () => {
  const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  await assert.rejects(
    fetchStableVersions('/project', 'brace-expansion', fakeSpawn({ error }, []), 'linux'),
    /npm is not available on PATH/,
  )
})
