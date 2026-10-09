import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readNpmContext, runNpmAudit } from '../src/npm-audit.js'

const valid = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }

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

test('audits all dependency types with argv spawning and explicit cwd', async () => {
  const calls = []
  const root = '/tmp/project $(touch unexpected) with spaces'
  const audit = await runNpmAudit(root, fakeSpawn([{ code: 1, stdout: JSON.stringify(valid) }], calls))
  assert.deepEqual(audit, valid)
  assert.deepEqual(calls[0], {
    command: 'npm',
    args: ['audit', '--json', '--include=prod', '--include=dev', '--include=optional', '--include=peer'],
    options: { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  })
})

test('accepts clean audit exit zero', async () => {
  assert.deepEqual(await runNpmAudit('/project', fakeSpawn([{ stdout: JSON.stringify(valid) }], [])), valid)
})

for (const response of [
  { code: 1, stdout: JSON.stringify({ error: { code: 'EAUDIT' } }) },
  { code: 2, stdout: JSON.stringify(valid) },
  { code: 0, stdout: '{not json' },
  { code: 0, stdout: JSON.stringify({ auditReportVersion: 2, metadata: {} }) },
  { error: new Error('spawn failed') },
  { code: 1, stdout: JSON.stringify({ ...valid, vulnerabilities: { dep: { via: [null, 42], nodes: ['node_modules/dep'] } } }) },
  { code: 1, stdout: JSON.stringify({ ...valid, vulnerabilities: { dep: { via: [{ source: 1, title: 'bad', severity: 'high', range: 'not a range' }], nodes: ['node_modules/dep'] } } }) },
]) {
  test(`rejects failed or malformed npm response ${JSON.stringify(response)}`, async () => {
    await assert.rejects(runNpmAudit('/project', fakeSpawn([response], [])))
  })
}

test('reads npm version and effective audit registry', async () => {
  const calls = []
  const context = await readNpmContext('/project', fakeSpawn([
    { stdout: '12.1.0\n' },
    { stdout: 'undefined\n' },
    { stdout: 'https://registry.example/\n' },
  ], calls))
  assert.deepEqual(context, { version: '12.1.0', registry: 'https://registry.example/' })
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['config', 'get', 'audit-registry'], ['config', 'get', 'registry']])
  assert.ok(calls.every(call => call.options.cwd === '/project' && call.options.shell === false))

  const directCalls = []
  const direct = await readNpmContext('/project', fakeSpawn([
    { stdout: '12.1.0\n' },
    { stdout: 'https://audit.example/\n' },
  ], directCalls))
  assert.equal(direct.registry, 'https://audit.example/')
  assert.equal(directCalls.length, 2)
})
