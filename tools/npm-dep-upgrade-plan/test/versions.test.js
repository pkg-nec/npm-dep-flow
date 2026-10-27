import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { clearNpmDepVersionsCache, runNpmDepVersions } from '../src/versions.js'

function spawnFixture(response, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    queueMicrotask(() => {
      if (response.error) return child.emit('error', response.error)
      child.stdout.end(response.stdout ?? '')
      child.stderr.end(response.stderr ?? '')
      child.emit('close', response.code ?? 0)
    })
    return child
  }
}

const report = { schemaVersion: 2, package: '@scope/pkg', fetchedAt: '2026-01-01T00:00:00.000Z', rows: [{ version: '2.0.0', releasedAt: null }, { version: '1.0.0', releasedAt: '2025-01-01T00:00:00.000Z' }] }
const now = () => Date.parse('2026-01-01T00:00:01.000Z')
test('catalog adapter forwards TTL and bypass through one public command and sorts stable rows', async () => {
  const calls = []
  const data = await runNpmDepVersions('/project with spaces', '@scope/pkg', spawnFixture({ stdout: JSON.stringify(report) }, calls), 'linux', { ttlMs: 1800000, noCache: true, now })
  assert.deepEqual(calls[0], { command: 'npm-dep-versions', args: ['@scope/pkg', '--format', 'json', '--cache-ttl', '1800s', '--no-cache'], options: { cwd: '/project with spaces', shell: false, stdio: ['ignore', 'pipe', 'pipe'] } })
  assert.deepEqual(data.versions, ['1.0.0', '2.0.0'])
  assert.deepEqual([...data.releaseTimes], [['1.0.0', '2025-01-01T00:00:00.000Z']])
  assert.equal(data.fetchedAt, report.fetchedAt)
  const windows = []
  await runNpmDepVersions('C:\\app & files', '@scope/pkg', spawnFixture({ stdout: JSON.stringify(report) }, windows), 'win32', { now })
  assert.equal(windows[0].command, 'npm-dep-versions.cmd @scope/pkg --format json --cache-ttl 3600s')
  assert.equal(windows[0].options.shell, true)
})
test('catalog adapter rejects malformed, stale, mismatched and prerelease evidence', async () => {
  for (const value of [null, { ...report, schemaVersion: 1 }, { ...report, package: 'other' }, { ...report, fetchedAt: '2026-01-01T01:00:00.000Z' }, { ...report, fetchedAt: '2025-12-31T23:00:01.000Z' }, { ...report, rows: [report.rows[0], report.rows[0]] }, { ...report, rows: [{ version: '1.0.0-beta.1', releasedAt: null }] }, { ...report, rows: [{ version: 'v1.0.0', releasedAt: null }] }, { ...report, rows: [{ version: '1.0.0', releasedAt: '2026-02-30T00:00:00.000Z' }] }]) {
    await assert.rejects(runNpmDepVersions('/p', '@scope/pkg', spawnFixture({ stdout: JSON.stringify(value) }), 'linux', { now }), /Invalid npm-dep-versions JSON/)
  }
  await assert.rejects(runNpmDepVersions('/p', '@scope/pkg', spawnFixture({ stdout: JSON.stringify(report) }), 'linux', { now: () => now() + 3600000 }), /Invalid/)
})
test('catalog adapter never leaks command bodies or credential-bearing stderr', async () => {
  for (const response of [{ stdout: '{SECRET' }, { code: 1, stderr: 'SECRET' }]) await assert.rejects(runNpmDepVersions('/p', '@scope/pkg', spawnFixture(response), 'linux', { now }), e => !e.message.includes('SECRET'))
  await assert.rejects(runNpmDepVersions('/p', '@scope/pkg', spawnFixture({ error: Object.assign(new Error('private'), { code: 'ENOENT' }) })), /npm-dep-versions.*PATH/)
  await assert.rejects(runNpmDepVersions('/p', 'bad&name', () => assert.fail('unsafe spawn')), /package/i)
})

test('catalog adapter forwards a clear request on Unix and Windows', async () => {
  for (const platform of ['linux', 'win32']) {
    for (const [controls, expected] of [[{ clearCache: true }, ['--clear-cache']], [{ noCache: true, clearCache: true }, ['--no-cache', '--clear-cache']], [{}, []]]) {
      const calls = []
      await runNpmDepVersions('/project', '@scope/pkg', spawnFixture({ stdout: JSON.stringify(report) }, calls), platform, { ttlMs: 3600000, now, ...controls })
      const argv = platform === 'win32' ? calls[0].command.split(' ').slice(1) : calls[0].args
      assert.deepEqual(argv, ['@scope/pkg', '--format', 'json', '--cache-ttl', '3600s', ...expected])
    }
  }
})

test('clear-only adapter runs npm-dep-versions --clear-cache on Unix and Windows and reports failures', async () => {
  for (const platform of ['linux', 'win32']) {
    const calls = []
    await clearNpmDepVersionsCache('/project', spawnFixture({ stdout: '' }, calls), platform)
    const argv = platform === 'win32' ? calls[0].command.split(' ').slice(1) : calls[0].args
    assert.deepEqual(argv, ['--clear-cache'])
  }
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  await assert.rejects(clearNpmDepVersionsCache('/project', spawnFixture({ error }, [])), /npm-dep-versions is not available on PATH/)
  await assert.rejects(clearNpmDepVersionsCache('/project', spawnFixture({ code: 1, stderr: 'EACCES' }, [])), /npm-dep-versions --clear-cache failed with exit code 1: EACCES/)
})
