import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const enabled = process.env.NPM_DEP_AUDIT_INTEGRATION === '1'
const scratchRoot = process.env.NPM_DEP_FLOW_TEST_TMPDIR || fileURLToPath(new URL('../../../tmp/npm-dep-upgrade-plan-clear-cache-integration/', import.meta.url))
const plannerBinPath = fileURLToPath(new URL('../bin/npm-dep-upgrade-plan.js', import.meta.url))
const siblingBins = {
  'npm-dep-audit': fileURLToPath(new URL('../../npm-dep-audit/bin/npm-dep-audit.js', import.meta.url)),
  'npm-dep-paths': fileURLToPath(new URL('../../npm-dep-paths/bin/npm-dep-paths.js', import.meta.url)),
  'npm-dep-versions': fileURLToPath(new URL('../../npm-dep-versions/bin/npm-dep-versions.js', import.meta.url)),
}
const cacheTools = ['npm-dep-upgrade-plan', 'npm-dep-audit', 'npm-dep-paths', 'npm-dep-versions']

// Real planner, audit, paths and versions executables from this checkout (through shims on PATH); only npm is faked.
function createFixture(t) {
  mkdirSync(scratchRoot, { recursive: true })
  const base = mkdtempSync(path.join(scratchRoot, 'run-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, 'project')
  const commandDirectory = path.join(base, 'commands')
  const cacheHome = path.join(base, 'cache')
  mkdirSync(project, { recursive: true })
  mkdirSync(commandDirectory, { recursive: true })
  const manifest = { name: 'clear-cache-integration', version: '1.0.0', dependencies: { 'brace-expansion': '^5.0.5' } }
  const lock = {
    name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
      'node_modules/brace-expansion': { version: '5.0.9' },
    },
  }
  writeFileSync(path.join(project, 'package.json'), `${JSON.stringify(manifest)}\n`)
  writeFileSync(path.join(project, 'package-lock.json'), `${JSON.stringify(lock)}\n`)
  const audit = {
    auditReportVersion: 2,
    metadata: { vulnerabilities: { total: 1 } },
    vulnerabilities: {
      'brace-expansion': {
        name: 'brace-expansion', severity: 'high', nodes: ['node_modules/brace-expansion'],
        via: [{ source: 123, name: 'brace-expansion', title: 'Fixture advisory', url: 'https://example.test/advisory', severity: 'high', range: '<5.0.12' }],
      },
    },
  }
  const npmScript = `const args = process.argv.slice(2)
if (args[0] === '--version') process.stdout.write('12.1.0\\n')
else if (args[0] === 'config' && args[1] === 'list') process.stdout.write('{}')
else if (args[0] === 'config' && args[2] === 'audit-registry') process.stdout.write('undefined\\n')
else if (args[0] === 'config' && args[2] === 'registry') process.stdout.write('https://registry.example/\\n')
else if (args[0] === 'audit') { process.stdout.write(process.env.CLEAR_AUDIT_JSON); process.exitCode = 1 }
else if (args[0] === 'view') process.stdout.write(JSON.stringify({ versions: ['5.0.9', '5.0.12'], time: { '5.0.12': '2026-10-01T12:00:00.000Z' } }))
else { process.stderr.write('unexpected npm arguments: ' + args.join(' ')); process.exitCode = 2 }
`
  writeFileSync(path.join(commandDirectory, 'fake-npm.js'), npmScript)
  if (process.platform === 'win32') {
    writeFileSync(path.join(commandDirectory, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`)
  }
  else {
    writeFileSync(path.join(commandDirectory, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.js" "$@"\n')
    chmodSync(path.join(commandDirectory, 'npm'), 0o755)
  }
  for (const [name, entry] of Object.entries(siblingBins)) {
    if (process.platform === 'win32') {
      writeFileSync(path.join(commandDirectory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
    }
    else {
      writeFileSync(path.join(commandDirectory, name), `#!/bin/sh\nexec node "${entry}" "$@"\n`)
      chmodSync(path.join(commandDirectory, name), 0o755)
    }
  }
  const env = {
    ...process.env,
    PATH: `${commandDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    CLEAR_AUDIT_JSON: JSON.stringify(audit),
    XDG_CACHE_HOME: cacheHome,
  }
  const run = (args = []) => spawnSync(process.execPath, [plannerBinPath, project, ...args, '--format', 'json'], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  const runRaw = args => spawnSync(process.execPath, [plannerBinPath, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  const entries = tool => (existsSync(path.join(cacheHome, tool)) ? readdirSync(path.join(cacheHome, tool)) : [])
  const plant = tool => writeFileSync(path.join(cacheHome, tool, 'stale-sentinel'), 'stale')
  return { run, runRaw, entries, plant }
}

test('--clear-cache clears planner, audit, paths and versions caches; --no-cache leaves them', { skip: !enabled }, (t) => {
  const fixture = createFixture(t)
  const first = fixture.run()
  assert.equal(first.status, 0, first.stderr)
  for (const tool of cacheTools) {
    assert.ok(fixture.entries(tool).length > 0, `${tool} cache populated by a normal run`)
    fixture.plant(tool)
  }

  const bypass = fixture.run(['--no-cache'])
  assert.equal(bypass.status, 0, bypass.stderr)
  for (const tool of cacheTools) assert.ok(fixture.entries(tool).includes('stale-sentinel'), `${tool} sentinel survives --no-cache`)

  const cleared = fixture.run(['--clear-cache'])
  assert.equal(cleared.status, 0, cleared.stderr)
  assert.deepEqual(JSON.parse(cleared.stdout).rows, JSON.parse(first.stdout).rows)
  for (const tool of cacheTools) {
    assert.ok(!fixture.entries(tool).includes('stale-sentinel'), `${tool} sentinel removed by --clear-cache`)
    assert.ok(fixture.entries(tool).length > 0, `${tool} cache rewritten with fresh entries`)
  }
})

test('--clear-cache with --no-cache clears every cache and writes none', { skip: !enabled }, (t) => {
  const fixture = createFixture(t)
  assert.equal(fixture.run().status, 0)
  for (const tool of cacheTools) fixture.plant(tool)
  const result = fixture.run(['--clear-cache', '--no-cache'])
  assert.equal(result.status, 0, result.stderr)
  for (const tool of cacheTools) assert.deepEqual(fixture.entries(tool), [], `${tool} cache empty`)
})

test('--clear-cache with no project clears the whole chain and analyzes nothing', { skip: !enabled }, (t) => {
  const fixture = createFixture(t)
  assert.equal(fixture.run().status, 0)
  for (const tool of cacheTools) assert.ok(fixture.entries(tool).length > 0)
  const result = fixture.runRaw(['--clear-cache'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  for (const tool of cacheTools) assert.deepEqual(fixture.entries(tool), [], `${tool} cache empty`)
})
