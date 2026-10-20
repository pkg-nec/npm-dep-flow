import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { main } from '../src/cli.js'

const lock = {
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/dep': { version: '1.1.1' },
    'node_modules/nested/node_modules/dep': { version: '1.1.2' },
  },
}
const audit = {
  auditReportVersion: 2,
  metadata: { vulnerabilities: { total: 1 } },
  vulnerabilities: {
    dep: {
      name: 'dep', severity: 'high',
      via: [{ source: 1, title: 'Issue one', url: 'https://example.test/1', severity: 'high', range: '<1.1.3' }],
      nodes: ['node_modules/dep', 'node_modules/nested/node_modules/dep'],
    },
  },
}

function summary(packageName, packages) {
  return {
    schemaVersion: 2,
    project: { name: 'sample', version: '1.0.0' },
    selector: packageName,
    results: packages.map(([version, targetLocation, declaredRequirement]) => ({
      package: packageName,
      version,
      requirements: [{
        declaredRequirement,
        directDependents: [{
          name: `${packageName}-parent`,
          version: '2.0.0',
          location: `node_modules/${packageName}-parent`,
          targetLocation,
          type: 'dependencies',
          requestedName: packageName,
        }],
      }],
    })),
  }
}

function harness() {
  let stdout = ''
  let stderr = ''
  let loadedPath
  let options
  const pathCalls = []
  const summaries = {
    dep: summary('dep', [
      ['1.1.1', 'node_modules/dep', '1.1.1'],
      ['1.1.2', 'node_modules/nested/node_modules/dep', '^1.1.0'],
    ]),
  }
  const io = { stdout: { write: (value) => {
    stdout += value
  } }, stderr: { write: (value) => {
    stderr += value
  } } }
  const deps = {
    readPathsIdentity: async () => 'npm-dep-paths v0.4.1',
    loadProject: async (path) => {
      loadedPath = path
      return { root: '/project', manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}'), lock }
    },
    readNpmContext: async () => ({ version: '12.1.0', registry: 'https://registry.example/' }),
    getAudit: async (_project, _context, selected) => {
      options = selected
      return { audit, auditedAt: '2026-10-09T00:00:00.000Z' }
    },
    runNpmDepPaths: async (_root, packageName) => {
      pathCalls.push(packageName)
      if (!summaries[packageName]) throw new Error(`missing fixture summary for ${packageName}`)
      return summaries[packageName]
    },
  }
  return {
    io, deps, summaries, pathCalls,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    get loadedPath() {
      return loadedPath
    },
    get options() {
      return options
    },
  }
}

test('defaults to current project, Markdown, all severities, one-hour cache, and one name query for both versions', async () => {
  const h = harness()
  assert.equal(await main([], h.io, h.deps), 0, h.stderr)
  assert.equal(h.loadedPath, process.cwd())
  assert.equal(h.options.ttlMs, 3600000)
  assert.equal(h.options.noCache, false)
  assert.deepEqual(h.pathCalls, ['dep'])
  assert.equal(h.stdout.split('\n').filter(line => line.startsWith('| dep ')).length, 2)
  assert.match(h.stdout, /1\.1\.1 → dep-parent@2\.0\.0 \[dependencies\]/)
  assert.match(h.stdout, /\^1\.1\.0 → dep-parent@2\.0\.0 \[dependencies\]/)
  assert.equal(h.stderr, '')
})

test('accepts project path, JSON, severity, TTL, and cache bypass', async () => {
  const h = harness()
  assert.equal(await main(['/another/project', '--format', 'json', '--min-severity', 'high', '--cache-ttl', '30m', '--no-cache'], h.io, h.deps), 0, h.stderr)
  assert.equal(h.loadedPath, '/another/project')
  assert.equal(h.options.ttlMs, 1800000)
  assert.equal(h.options.noCache, true)
  const output = JSON.parse(h.stdout)
  assert.equal(output.schemaVersion, 2)
  assert.deepEqual(output.rows.map(row => row.version), ['1.1.1', '1.1.2'])
  assert.ok(output.rows.every(row => Array.isArray(row.requirements) && !Object.hasOwn(row, 'paths')))
  assert.deepEqual(h.pathCalls, ['dep'])
})

test('accepts flags first with an omitted or explicit project path', async () => {
  for (const pathArgs of [[], ['.'], ['../target'], ['/another/project']]) {
    const h = harness()
    assert.equal(await main(['--format', 'json', '--min-severity', 'high', '--cache-ttl', '30m', '--no-cache', ...pathArgs], h.io, h.deps), 0, h.stderr)
    assert.equal(h.loadedPath, pathArgs[0] ?? process.cwd())
    assert.equal(h.options.ttlMs, 1800000)
    assert.equal(h.options.noCache, true)
    assert.deepEqual(JSON.parse(h.stdout).rows.map(row => row.version), ['1.1.1', '1.1.2'])
    assert.equal(h.stderr, '')
  }
})

test('queries each distinct kept package name once and attaches only matching versions', async () => {
  const h = harness()
  const multiLock = {
    lockfileVersion: 3,
    packages: { ...lock.packages, 'node_modules/other': { version: '4.0.0' } },
  }
  const multiAudit = {
    ...audit,
    vulnerabilities: {
      ...audit.vulnerabilities,
      other: {
        name: 'other', severity: 'critical',
        via: [{ source: 2, title: 'Other issue', url: 'https://example.test/2', severity: 'critical', range: '*' }],
        nodes: ['node_modules/other'],
      },
    },
  }
  h.deps.loadProject = async () => ({ root: '/project', manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}'), lock: multiLock })
  h.deps.getAudit = async () => ({ audit: multiAudit, auditedAt: '2026-10-09T00:00:00.000Z' })
  h.summaries.other = summary('other', [['4.0.0', 'node_modules/other', '4.0.0']])
  assert.equal(await main(['--format', 'json'], h.io, h.deps), 0, h.stderr)
  assert.deepEqual(new Set(h.pathCalls), new Set(['dep', 'other']))
  assert.equal(h.pathCalls.length, 2)
  assert.deepEqual(JSON.parse(h.stdout).rows.map(row => [row.package, row.version]), [
    ['other', '4.0.0'], ['dep', '1.1.1'], ['dep', '1.1.2'],
  ])
})

test('severity filtering follows enrichment and empty findings skip dependency path queries', async () => {
  const h = harness()
  assert.equal(await main(['--min-severity', 'critical'], h.io, h.deps), 0)
  assert.deepEqual(h.pathCalls, ['dep'])
  assert.match(h.stdout, /No matching direct advisories/)

  const empty = harness()
  empty.deps.getAudit = async () => ({ audit: { ...audit, vulnerabilities: {} }, auditedAt: '2026-10-09T00:00:00.000Z' })
  assert.equal(await main([], empty.io, empty.deps), 0)
  assert.deepEqual(empty.pathCalls, [])
})

test('expired audit timestamps do not make enriched reports reusable', async () => {
  const h = harness()
  assert.equal(await main([], h.io, h.deps), 0, h.stderr)
  assert.equal(await main([], h.io, h.deps), 0, h.stderr)
  assert.deepEqual(h.pathCalls, ['dep', 'dep'])
})

test('path CLI and join failures leave stdout empty', async () => {
  for (const [runPaths, message] of [
    [async () => {
      throw new Error('paths executable failed')
    }, /paths executable failed/],
    [async () => summary('dep', []), /did not return dep@1\.1\.1/],
  ]) {
    const h = harness()
    h.deps.runNpmDepPaths = runPaths
    assert.notEqual(await main([], h.io, h.deps), 0)
    assert.equal(h.stdout, '')
    assert.match(h.stderr, message)
  }
})

test('help returns without auditing or querying npm-dep-paths', async () => {
  const h = harness()
  assert.equal(await main(['--help'], h.io, { loadProject: () => {
    throw new Error('must not audit')
  } }), 0)
  assert.match(h.stdout, /--min-severity/)
  assert.deepEqual(h.pathCalls, [])
})

for (const args of [['--wat'], ['--format', 'xml'], ['--min-severity', 'urgent'], ['--cache-ttl', '0m'], ['--cache-ttl', '1'], ['one', 'two']]) {
  test(`rejects invalid arguments ${args.join(' ')}`, async () => {
    const h = harness()
    assert.notEqual(await main(args, h.io, h.deps), 0)
    assert.equal(h.stdout, '')
    assert.notEqual(h.stderr, '')
    assert.deepEqual(h.pathCalls, [])
  })
}

test('audit failure leaves stdout empty and does not invoke npm-dep-paths', async () => {
  const h = harness()
  h.deps.getAudit = async () => {
    throw new Error('registry unavailable')
  }
  assert.notEqual(await main([], h.io, h.deps), 0)
  assert.equal(h.stdout, '')
  assert.match(h.stderr, /registry unavailable/)
  assert.deepEqual(h.pathCalls, [])
})

async function fakeCommand(binDir, name, source) {
  await writeFile(join(binDir, `${name}.js`), `if ('${name}' !== 'npm' && process.argv.includes('--version')) { process.stdout.write('${name} v1.0.0\\nLocation: fixture\\n'); process.exit(0); }\n${source}\n`)
  if (process.platform === 'win32') {
    return writeFile(join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`)
  }
  const executable = join(binDir, name)
  await writeFile(executable, `#!/usr/bin/env node\nrequire('./${name}.js')\n`)
  return chmod(executable, 0o755)
}

test('bin renders dependency requirements in Markdown and JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'npm-dep-audit-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const projectDir = join(dir, 'project')
  const binDir = join(dir, 'bin')
  await mkdir(projectDir)
  await mkdir(binDir)
  await writeFile(join(projectDir, 'package.json'), '{"name":"sample","version":"1.0.0"}')
  await writeFile(join(projectDir, 'package-lock.json'), JSON.stringify(lock))

  const fakeNpmSource = `const args=process.argv.slice(2); if(args[0]==='--version') console.log('12.1.0'); else if(args[0]==='config') console.log(args[2]==='audit-registry'?'undefined':'https://registry.example/'); else if(args[0]==='audit') { console.log(${JSON.stringify(JSON.stringify(audit))}); process.exitCode=1 } else process.exitCode=2;`
  const summaries = summary('dep', [
    ['1.1.1', 'node_modules/dep', '1.1.1'],
    ['1.1.2', 'node_modules/nested/node_modules/dep', '^1.1.0'],
  ])
  const fakePathsSource = `require('node:fs').appendFileSync(process.env.AUDIT_PATHS_CALLS, 'query\\n'); console.log(${JSON.stringify(JSON.stringify(summaries))});`
  await Promise.all([fakeCommand(binDir, 'npm', fakeNpmSource), fakeCommand(binDir, 'npm-dep-paths', fakePathsSource)])

  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, XDG_CACHE_HOME: join(dir, 'cache'), AUDIT_PATHS_CALLS: join(dir, 'paths-calls.log') }
  const executable = join(process.cwd(), 'bin/npm-dep-audit.js')
  const markdown = spawnSync(process.execPath, [executable, projectDir], { env, encoding: 'utf8' })
  assert.equal(markdown.status, 0, markdown.stderr || markdown.error?.message)
  assert.match(markdown.stdout, /Declared requirements/)
  assert.match(markdown.stdout, /\^1\.1\.0 → dep-parent@2\.0\.0/)

  const json = spawnSync(process.execPath, [executable, projectDir, '--format', 'json'], { env, encoding: 'utf8' })
  assert.equal(json.status, 0, json.stderr || json.error?.message)
  const report = JSON.parse(json.stdout)
  const { readFile } = await import('node:fs/promises')
  assert.equal(await readFile(env.AUDIT_PATHS_CALLS, 'utf8'), 'query\n')
  assert.equal(report.schemaVersion, 2)
  assert.deepEqual(report.rows.map(row => row.version), ['1.1.1', '1.1.2'])
  assert.ok(report.rows.every(row => Array.isArray(row.requirements) && !Object.hasOwn(row, 'paths')))
  for (const pathArgs of [[], ['.'], ['../project'], [projectDir]]) {
    const current = spawnSync(process.execPath, [executable, '--format', 'json', '--min-severity', 'high', '--no-cache', ...pathArgs], { cwd: projectDir, env, encoding: 'utf8' })
    assert.equal(current.status, 0, current.stderr || current.error?.message)
    assert.equal(current.stderr, '')
    assert.deepEqual(JSON.parse(current.stdout).rows, report.rows)
  }
  assert.equal((await readFile(env.AUDIT_PATHS_CALLS, 'utf8')).trim().split('\n').length, 5)
})

test('enriched reports reuse paths across severity filters and bypass without overwriting cache', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-result-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const h = harness()
  const auditedAt = new Date().toISOString()
  h.deps.loadProject = async () => ({ root: dir, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}'), lock })
  h.deps.getAudit = async () => ({ audit, auditedAt })
  h.deps.readPathsIdentity = async () => 'paths v1'
  for (const args of [['--min-severity', 'critical'], ['--format', 'json'], []]) {
    assert.equal(await main(args, h.io, h.deps), 0, h.stderr)
  }
  assert.deepEqual(h.pathCalls, ['dep'])
  assert.equal(await main(['--no-cache'], h.io, h.deps), 0, h.stderr)
  assert.deepEqual(h.pathCalls, ['dep', 'dep'])
  assert.equal(await main([], h.io, h.deps), 0, h.stderr)
  assert.deepEqual(h.pathCalls, ['dep', 'dep'])
  h.deps.readPathsIdentity = async () => 'paths v2'
  assert.equal(await main([], h.io, h.deps), 0, h.stderr)
  assert.deepEqual(h.pathCalls, ['dep', 'dep', 'dep'])
})
