import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runNpmDepAudit } from '../src/audit.js'

function auditReport() {
  return {
    schemaVersion: 2,
    auditedAt: '2026-10-13T06:00:00.000Z',
    rows: [{
      package: 'brace-expansion',
      version: '5.0.9',
      severity: 'high',
      advisories: [{
        id: 'GHSA-test-1234-abcd',
        title: 'A test vulnerability',
        url: 'https://example.test/advisory',
        severity: 'high',
        range: '<5.0.12',
      }],
      requirements: [{
        declaredRequirement: '^5.0.5',
        directDependents: [{
          name: 'minimatch',
          version: '10.2.5',
          location: '',
          targetLocation: 'node_modules/brace-expansion',
          type: 'dependencies',
          requestedName: 'brace-expansion',
        }],
      }],
    }],
  }
}

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

test('audit adapter invokes npm-dep-audit with the public JSON contract on Unix', async () => {
  const calls = []
  const root = '/tmp/project with spaces'
  const expected = auditReport()
  const report = await runNpmDepAudit(root, fakeSpawn({ stdout: JSON.stringify(expected) }, calls), 'linux')

  assert.deepEqual(calls, [{
    command: 'npm-dep-audit',
    args: ['.', '--min-severity', 'info', '--format', 'json'],
    options: { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
  assert.deepEqual(report, expected)
  assert.equal(report.rows[0].requirements[0].directDependents[0].location, '')
})

test('audit adapter uses the Windows command shim', async () => {
  const calls = []
  const root = 'C:\\Projects\\my app'
  const report = auditReport()
  assert.deepEqual(await runNpmDepAudit(root, fakeSpawn({ stdout: JSON.stringify(report) }, calls), 'win32'), report)
  assert.deepEqual(calls, [{
    command: 'npm-dep-audit.cmd . --min-severity info --format json',
    args: [],
    options: { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  }])
})

const invalidReports = [
  ['wrong schema version', (report) => {
    report.schemaVersion = 1
  }, /schema version 2/],
  ['invalid auditedAt', (report) => {
    report.auditedAt = 'yesterday'
  }, /auditedAt/],
  ['malformed row', (report) => {
    delete report.rows[0].package
  }, /row 0/],
  ['invalid advisory range', (report) => {
    report.rows[0].advisories[0].range = '<not-semver'
  }, /advisory range/],
  ['empty requirements', (report) => {
    report.rows[0].requirements = []
  }, /requirement groups/],
  ['empty direct-dependent links', (report) => {
    report.rows[0].requirements[0].directDependents = []
  }, /direct dependents/],
  ['malformed direct-dependent link', (report) => {
    report.rows[0].requirements[0].directDependents[0].version = 1
  }, /direct dependent/],
]

for (const [name, mutate, expectedError] of invalidReports) {
  test(`audit adapter rejects ${name}`, async () => {
    const report = auditReport()
    mutate(report)
    await assert.rejects(
      runNpmDepAudit('/project', fakeSpawn({ stdout: JSON.stringify(report) }, []), 'linux'),
      expectedError,
    )
  })
}

test('audit adapter accepts an empty findings list', async () => {
  const report = { ...auditReport(), rows: [] }
  assert.deepEqual(await runNpmDepAudit('/project', fakeSpawn({ stdout: JSON.stringify(report) }, []), 'linux'), report)
})

test('audit adapter rejects invalid JSON without echoing its content', async () => {
  await assert.rejects(
    runNpmDepAudit('/project', fakeSpawn({ stdout: '{secret-token' }, []), 'linux'),
    error => /invalid JSON/i.test(error.message) && !error.message.includes('secret-token'),
  )
})

test('audit adapter preserves trimmed failed-command diagnostics', async () => {
  await assert.rejects(
    runNpmDepAudit('/project', fakeSpawn({ code: 1, stderr: '  npm-dep-audit: Unsupported npm workspaces\n', stdout: 'do not echo' }, []), 'linux'),
    error => /npm-dep-audit failed with exit code 1/.test(error.message)
      && error.message.endsWith('npm-dep-audit: Unsupported npm workspaces')
      && !error.message.includes('do not echo'),
  )
})

test('audit adapter retains guidance when a failed command has no diagnostic', async () => {
  await assert.rejects(
    runNpmDepAudit('/project', fakeSpawn({ code: 2, stderr: '  \n', stdout: 'do not echo' }, []), 'linux'),
    error => /exit code 2/.test(error.message) && /supported npm project/.test(error.message)
      && /npm-dep-paths/.test(error.message) && !error.message.includes('do not echo'),
  )
})

test('audit adapter gives installation guidance when the command is missing', async () => {
  const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  await assert.rejects(
    runNpmDepAudit('/project', fakeSpawn({ error }, []), 'linux'),
    /npm-dep-audit is not available on PATH/,
  )
})

test('planner forwards TTL and bypass to audit on Unix and Windows', async () => {
  for (const platform of ['linux', 'win32']) {
    const calls = []
    const result = await runNpmDepAudit('/project', fakeSpawn({ stdout: JSON.stringify(auditReport()) }, calls), platform, { noCache: true, ttlMs: 1800000 })
    assert.equal(result.rows[0].version, '5.0.9')
    const argv = platform === 'win32' ? calls[0].command.split(' ').slice(1) : calls[0].args
    assert.deepEqual(argv, ['.', '--min-severity', 'info', '--format', 'json', '--cache-ttl', '1800s', '--no-cache'])
  }
})
