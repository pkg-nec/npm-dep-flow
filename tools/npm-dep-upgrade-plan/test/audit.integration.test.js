import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const enabled = process.env.NPM_DEP_AUDIT_INTEGRATION === '1'
const scratchRoot = process.env.NPM_DEP_FLOW_TEST_TMPDIR || fileURLToPath(new URL('../../../tmp/npm-dep-upgrade-plan-audit-integration/', import.meta.url))
const plannerBinPath = fileURLToPath(new URL('../bin/npm-dep-upgrade-plan.js', import.meta.url))

function createFixture(t) {
  mkdirSync(scratchRoot, { recursive: true })
  const base = mkdtempSync(path.join(scratchRoot, 'run-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))

  const project = path.join(base, 'project with spaces & symbols')
  const commandDirectory = path.join(base, 'commands')
  mkdirSync(project, { recursive: true })
  mkdirSync(commandDirectory, { recursive: true })

  const manifest = {
    name: 'planner-audit-integration',
    version: '1.0.0',
    dependencies: { 'brace-expansion': '^5.0.5' },
  }
  const lock = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
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
        name: 'brace-expansion',
        severity: 'high',
        via: [{
          source: 123,
          name: 'brace-expansion',
          title: 'Fixture advisory',
          url: 'https://example.test/advisory',
          severity: 'high',
          range: '<5.0.12',
        }],
        nodes: ['node_modules/brace-expansion'],
      },
    },
  }
  const paths = {
    schemaVersion: 2,
    project: { name: manifest.name, version: manifest.version },
    selector: 'brace-expansion',
    results: [{
      package: 'brace-expansion',
      version: '5.0.9',
      requirements: [{
        declaredRequirement: '^5.0.5',
        directDependents: [{
          name: manifest.name,
          version: manifest.version,
          location: '',
          targetLocation: 'node_modules/brace-expansion',
          type: 'dependencies',
          requestedName: 'brace-expansion',
        }],
      }],
    }],
  }

  const npmScript = `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.PLAN_NPM_CALLS, args.join(' ') + '\\n')
if (args[0] === '--version') process.stdout.write('12.1.0\\n')
else if (args[0] === 'config' && args[2] === 'audit-registry') process.stdout.write('undefined\\n')
else if (args[0] === 'config' && args[2] === 'registry') process.stdout.write('https://registry.example/\\n')
else if (args[0] === 'audit') { process.stdout.write(process.env.PLAN_AUDIT_JSON); process.exitCode = 1 }
else if (args[0] === 'view' && args[1] === 'brace-expansion' && args[2] === 'versions' && args[3] === '--json') process.stdout.write(process.env.PLAN_VERSIONS_JSON)
else if (args[0] === 'view' && args[1] === 'brace-expansion' && args[2] === 'time' && args[3] === '--json') process.stdout.write(process.env.PLAN_TIMES_JSON)
else { process.stderr.write('unexpected npm arguments: ' + args.join(' ')); process.exitCode = 2 }
`
  const pathsScript = `const fs = require('node:fs')
const args = process.argv.slice(2)
if (JSON.stringify(args) !== JSON.stringify(['.', 'brace-expansion', '--format', 'json'])) { process.stderr.write('unexpected npm-dep-paths arguments: ' + args.join(' ')); process.exitCode = 2 }
else { fs.appendFileSync(process.env.PLAN_PATHS_CALLS, args.join(' ') + '\\n'); process.stdout.write(process.env.PLAN_PATHS_JSON) }
`
  writeFileSync(path.join(commandDirectory, 'fake-npm.js'), `#!/usr/bin/env node\n${npmScript}`)
  writeFileSync(path.join(commandDirectory, 'fake-paths.js'), `#!/usr/bin/env node\n${pathsScript}`)

  const npmShim = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`
    : `#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.js" "$@"\n`
  const pathsShim = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake-paths.js" %*\r\n`
    : `#!/bin/sh\nexec node "$(dirname "$0")/fake-paths.js" "$@"\n`

  if (process.platform === 'win32') {
    writeFileSync(path.join(commandDirectory, 'npm.cmd'), npmShim)
    writeFileSync(path.join(commandDirectory, 'npm-dep-paths.cmd'), pathsShim)
  } else {
    writeFileSync(path.join(commandDirectory, 'npm'), npmShim)
    writeFileSync(path.join(commandDirectory, 'npm-dep-paths'), pathsShim)
    chmodSync(path.join(commandDirectory, 'npm'), 0o755)
    chmodSync(path.join(commandDirectory, 'npm-dep-paths'), 0o755)
  }

  const npmCalls = path.join(base, 'npm-calls.txt')
  const pathsCalls = path.join(base, 'paths-calls.txt')
  writeFileSync(npmCalls, '')
  writeFileSync(pathsCalls, '')
  const env = {
    ...process.env,
    PATH: `${commandDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    PLAN_AUDIT_JSON: JSON.stringify(audit),
    PLAN_VERSIONS_JSON: JSON.stringify(['5.0.9', '5.0.12']),
    PLAN_TIMES_JSON: JSON.stringify({
      '5.0.12': '2026-10-01T12:00:00.000Z',
    }),
    PLAN_PATHS_JSON: JSON.stringify(paths),
    PLAN_NPM_CALLS: npmCalls,
    PLAN_PATHS_CALLS: pathsCalls,
    XDG_CACHE_HOME: path.join(base, 'cache'),
  }

  const run = () => spawnSync(process.execPath, [plannerBinPath, project, '--format', 'json'], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 30000,
  })
  return { run, npmCalls, pathsCalls }
}

test('planner consumes JSON emitted by the real npm-dep-audit CLI', { skip: !enabled }, t => {
  const fixture = createFixture(t)
  const result = fixture.run()

  assert.equal(result.status, 0, JSON.stringify(result, null, 2))
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.rows[0].package, 'brace-expansion')
  assert.equal(report.rows[0].version, '5.0.9')
  assert.equal(report.rows[0].targetLocation, 'node_modules/brace-expansion')
  assert.equal(report.rows[0].severity, 'high')
  assert.equal(report.rows[0].minimumSafeVersion, '5.0.12')
  assert.equal(report.rows[0].minimumSafeVersionReleasedAt, '2026-10-01T12:00:00.000Z')
  assert.equal(report.rows[0].status, 'eligible')
  assert.deepEqual(report.rows[0].strategy, {
    id: 'update-within-declared-range',
    targetPackage: 'brace-expansion',
    currentVersion: '5.0.9',
    targetVersion: '5.0.12',
  })
  assert.equal('advisories' in report.rows[0], false)
  assert.equal('requirements' in report.rows[0], false)

  const npmCalls = readFileSync(fixture.npmCalls, 'utf8').trim().split('\n')
  assert.ok(npmCalls.some(call => call.startsWith('audit ')))
  assert.ok(npmCalls.includes('view brace-expansion versions --json'))
  assert.ok(npmCalls.includes('view brace-expansion time --json'))
  assert.equal(readFileSync(fixture.pathsCalls, 'utf8').trim(), '. brace-expansion --format json')
})
