import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { main } from '../src/cli.js'

const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/dep': { version: '1.1.1' }, 'node_modules/nested/node_modules/dep': { version: '1.1.2' } } }
const audit = { auditReportVersion: 2, metadata: { vulnerabilities: { total: 1 } }, vulnerabilities: {
  dep: { name: 'dep', severity: 'high', via: [{ source: 1, title: 'Issue one', url: 'https://example.test/1', severity: 'high', range: '<1.1.3' }], nodes: ['node_modules/dep', 'node_modules/nested/node_modules/dep'] },
} }

function harness() {
  let stdout = ''
  let stderr = ''
  let loadedPath
  let options
  const io = { stdout: { write: value => { stdout += value } }, stderr: { write: value => { stderr += value } } }
  const deps = {
    loadProject: async path => { loadedPath = path; return { root: '/project', manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}'), lock } },
    readNpmContext: async () => ({ version: '12.1.0', registry: 'https://registry.example/' }),
    getAudit: async (_project, _context, selected) => { options = selected; return { audit, auditedAt: '2026-10-09T00:00:00.000Z' } },
  }
  return { io, deps, get stdout() { return stdout }, get stderr() { return stderr }, get loadedPath() { return loadedPath }, get options() { return options } }
}

test('defaults to current project, Markdown, all severities, and one-hour cache', async () => {
  const h = harness()
  assert.equal(await main([], h.io, h.deps), 0)
  assert.equal(h.loadedPath, process.cwd())
  assert.equal(h.options.ttlMs, 3600000)
  assert.equal(h.options.noCache, false)
  assert.equal(h.stdout.split('\n').filter(line => line.startsWith('| dep ')).length, 2)
  assert.equal(h.stderr, '')
})

test('accepts project path, JSON, severity, TTL, and cache bypass', async () => {
  const h = harness()
  assert.equal(await main(['/another/project', '--format', 'json', '--min-severity', 'high', '--cache-ttl', '30m', '--no-cache'], h.io, h.deps), 0)
  assert.equal(h.loadedPath, '/another/project')
  assert.equal(h.options.ttlMs, 1800000)
  assert.equal(h.options.noCache, true)
  assert.deepEqual(JSON.parse(h.stdout).rows.map(row => row.version), ['1.1.1', '1.1.2'])
})

test('help returns without auditing', async () => {
  const h = harness()
  assert.equal(await main(['--help'], h.io, { loadProject: () => { throw new Error('must not audit') } }), 0)
  assert.match(h.stdout, /--min-severity/)
})

for (const args of [['--wat'], ['--format', 'xml'], ['--min-severity', 'urgent'], ['--cache-ttl', '0m'], ['--cache-ttl', '1'], ['one', 'two']]) {
  test(`rejects invalid arguments ${args.join(' ')}`, async () => {
    const h = harness()
    assert.notEqual(await main(args, h.io, h.deps), 0)
    assert.equal(h.stdout, '')
    assert.notEqual(h.stderr, '')
  })
}

test('audit failure leaves stdout empty', async () => {
  const h = harness()
  h.deps.getAudit = async () => { throw new Error('registry unavailable') }
  assert.notEqual(await main([], h.io, h.deps), 0)
  assert.equal(h.stdout, '')
  assert.match(h.stderr, /registry unavailable/)
})

test('bin emits one row per exact version in Markdown and JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-dep-audit-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const projectDir = join(dir, 'project')
  const binDir = join(dir, 'bin')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(projectDir)
  await mkdir(binDir)
  await writeFile(join(projectDir, 'package.json'), '{"name":"sample","version":"1.0.0"}')
  await writeFile(join(projectDir, 'package-lock.json'), JSON.stringify(lock))
  const fakeNpm = join(binDir, 'npm')
  await writeFile(fakeNpm, `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args[0]==='--version') console.log('12.1.0'); else if(args[0]==='config') console.log(args[2]==='audit-registry'?'undefined':'https://registry.example/'); else if(args[0]==='audit') { console.log(${JSON.stringify(JSON.stringify(audit))}); process.exitCode=1 } else process.exitCode=2;\n`)
  await chmod(fakeNpm, 0o755)
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, XDG_CACHE_HOME: join(dir, 'cache') }
  const executable = join(process.cwd(), 'bin/npm-dep-audit.js')
  const markdown = spawnSync(process.execPath, [executable, projectDir], { env, encoding: 'utf8' })
  assert.equal(markdown.status, 0, markdown.stderr || markdown.error?.message)
  assert.equal(markdown.stdout.split('\n').filter(line => line.startsWith('| dep ')).length, 2)
  const json = spawnSync(process.execPath, [executable, projectDir, '--format', 'json'], { env, encoding: 'utf8' })
  assert.equal(json.status, 0, json.stderr || json.error?.message)
  assert.deepEqual(JSON.parse(json.stdout).rows.map(row => row.version), ['1.1.1', '1.1.2'])
})
