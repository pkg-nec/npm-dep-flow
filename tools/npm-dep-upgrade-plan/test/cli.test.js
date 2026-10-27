import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { main } from '../src/cli.js'
import { renderJson, renderMarkdown } from '../src/report.js'

const scratchRoot = process.env.NPM_DEP_FLOW_TEST_TMPDIR || fileURLToPath(new URL('../../../tmp/npm-dep-upgrade-plan-cli/', import.meta.url))
const binPath = fileURLToPath(new URL('../bin/npm-dep-upgrade-plan.js', import.meta.url))

function dependent(name, version, location, targetLocation) {
  return {
    name,
    version,
    location,
    targetLocation,
    type: 'dependencies',
    requestedName: 'brace-expansion',
  }
}

function vulnerableRow(packageName, version, severity, requirements) {
  return {
    package: packageName,
    version,
    severity,
    advisories: [{
      id: `GHSA-${packageName}`,
      title: `Advisory for ${packageName}`,
      url: 'https://example.test/advisory',
      severity,
      range: packageName === 'brace-expansion' ? '<5.0.12' : '<1.0.2',
    }],
    requirements,
  }
}

function braceReport() {
  return {
    schemaVersion: 2,
    auditedAt: '2026-10-13T06:00:00.000Z',
    rows: [vulnerableRow('brace-expansion', '5.0.9', 'high', [
      {
        declaredRequirement: '5.0.9',
        directDependents: [dependent('nx', '23.1.2', 'node_modules/nx', 'node_modules/nx/node_modules/brace-expansion')],
      },
      {
        declaredRequirement: '^5.0.5',
        directDependents: [dependent('minimatch', '10.2.5', 'node_modules/minimatch', 'node_modules/brace-expansion')],
      },
    ])],
  }
}

function createIo() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: { write(value) {
        stdout += value
      } },
      stderr: { write(value) {
        stderr += value
      } },
    },
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

function injectedDeps(report, versions = new Map(), renderers = {}) {
  return {
    async loadProject(root) { return { root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') } },
    async readPlanningContext() { return { fixture: true } },
    async runNpmDepAudit() {
      return report
    },
    async runNpmDepVersions(projectRoot, packageName) {
      return { versions: versions.get(packageName) ?? [], releaseTimes: new Map(), fetchedAt: new Date().toISOString() }
    },
    async readUpstream() {
      return { nodes: new Map(), edges: [] }
    },
    async readReleasePolicy() {
      return { minAgeDays: 7, cutoffMs: null }
    },
    renderMarkdown: renderers.renderMarkdown ?? (() => 'markdown report\n'),
    renderJson: renderers.renderJson ?? (() => '{"schemaVersion":1}\n'),
  }
}

test('help short-circuits invalid arguments and does not run subprocess adapters', async () => {
  let calls = 0
  const io = createIo()
  const deps = {
    async runNpmDepAudit() {
      calls += 1
      throw new Error('must not run')
    },
    async runNpmDepVersions() {
      calls += 1
      throw new Error('must not run')
    },
    renderMarkdown() {
      calls += 1
      return ''
    },
    renderJson() {
      calls += 1
      return ''
    },
  }

  assert.equal(await main(['--unknown', 'one', 'two', '--help'], io.io, deps), 0)
  assert.match(io.stdout, /Usage: npm-dep-upgrade-plan/)
  assert.equal(calls, 0)
})

test('main defaults to the current directory and Markdown', async () => {
  const io = createIo()
  const report = { schemaVersion: 2, auditedAt: '2026-10-13T06:00:00.000Z', rows: [] }
  const calls = []
  const deps = injectedDeps(report, new Map(), {
    renderMarkdown(rows) {
      calls.push(['markdown', rows])
      return 'markdown report\n'
    },
  })
  const originalAudit = deps.runNpmDepAudit
  deps.runNpmDepAudit = async (root) => {
    calls.push(['audit', root])
    return originalAudit(root)
  }

  assert.equal(await main([], io.io, deps), 0)
  assert.deepEqual(calls, [['audit', process.cwd()], ['markdown', []]])
  assert.equal(io.stdout, 'markdown report\n')
  assert.equal(io.stderr, '')
})

test('main accepts an explicit project path and JSON format', async () => {
  const io = createIo()
  const report = { schemaVersion: 2, auditedAt: '2026-10-13T06:00:00.000Z', rows: [] }
  const calls = []
  const deps = injectedDeps(report, new Map(), {
    renderJson(rows, auditedAt) {
      calls.push(['json', rows, auditedAt])
      return renderJson(rows, auditedAt)
    },
  })
  deps.runNpmDepAudit = async (root) => {
    calls.push(['audit', root])
    return report
  }

  assert.equal(await main(['./fixture', '--format', 'json'], io.io, deps), 0)
  assert.deepEqual(calls, [
    ['audit', path.resolve('./fixture')],
    ['json', [], '2026-10-13T06:00:00.000Z'],
  ])
  assert.deepEqual(JSON.parse(io.stdout), {
    schemaVersion: 3,
    auditedAt: '2026-10-13T06:00:00.000Z',
    rows: [],
  })
})

test('main requests audit once and queries each distinct package name once', async () => {
  const report = braceReport()
  report.rows.push(vulnerableRow('left-pad', '1.0.1', 'low', [{
    declaredRequirement: '^1.0.0',
    directDependents: [dependent('app', '1.0.0', '', 'node_modules/left-pad')],
  }]))
  report.rows.push(vulnerableRow('brace-expansion', '5.0.8', 'moderate', [{
    declaredRequirement: '^5.0.5',
    directDependents: [dependent('other', '1.0.0', 'node_modules/other', 'node_modules/brace-expansion')],
  }]))
  const calls = { audit: 0, registry: [] }
  const io = createIo()
  const deps = injectedDeps(report, new Map(), {
    renderMarkdown: rows => `rows:${rows.length}\n`,
  })
  deps.runNpmDepAudit = async () => {
    calls.audit += 1
    return report
  }
  deps.runNpmDepVersions = async (root, packageName) => {
    calls.registry.push(packageName)
    return { versions: [], releaseTimes: new Map(), fetchedAt: new Date().toISOString() }
  }

  assert.equal(await main([], io.io, deps), 0)
  assert.equal(calls.audit, 1)
  assert.deepEqual(calls.registry, ['brace-expansion', 'left-pad'])
  assert.equal(io.stdout, 'rows:4\n')
})

test('main skips registry lookups for an empty audit report', async () => {
  const io = createIo()
  let registryCalls = 0
  const report = { schemaVersion: 2, auditedAt: '2026-10-13T06:00:00.000Z', rows: [] }
  const deps = injectedDeps(report)
  deps.runNpmDepVersions = async () => {
    registryCalls += 1
    return { versions: [], releaseTimes: new Map(), fetchedAt: new Date().toISOString() }
  }

  assert.equal(await main([], io.io, deps), 0)
  assert.equal(registryCalls, 0)
})

test('main evaluates every link and renders findings by severity', async () => {
  const report = braceReport()
  report.rows.unshift(vulnerableRow('left-pad', '1.0.1', 'critical', [{
    declaredRequirement: '1.0.1',
    directDependents: [dependent('app', '1.0.0', '', 'node_modules/left-pad')],
  }]))
  const io = createIo()
  const versions = new Map([
    ['brace-expansion', ['5.0.9', '5.0.12']],
    ['left-pad', ['1.0.1', '1.0.2']],
  ])
  assert.equal(await main([], io.io, injectedDeps(report, versions, { renderMarkdown })), 0)
  const lines = io.stdout.split('\n').filter(line => line.startsWith('| '))
  assert.equal(lines[2].includes('| left-pad |'), true)
  assert.equal(lines[3].includes('| brace-expansion |') && lines[4].includes('| brace-expansion |'), true)
  assert.match(io.stdout, /Highest severity/)
  assert.match(io.stdout, /node\\_modules\/nx\/node\\_modules\/brace-expansion \| none \| —/)
  assert.match(io.stdout, /node\\_modules\/brace-expansion \| complete \| Update within declared range \|/)
})

test('main returns success when all links are ineligible', async () => {
  const io = createIo()
  const report = braceReport()
  const result = await main([], io.io, injectedDeps(report, new Map([
    ['brace-expansion', ['5.0.9', '5.0.12']],
  ]), { renderMarkdown }))

  assert.equal(result, 0)
  assert.match(io.stdout, /\| none \| — \|/)
  assert.equal(io.stderr, '')
})

test('main leaves stdout empty when the audit command fails', async () => {
  const io = createIo()
  const deps = injectedDeps({ rows: [] })
  deps.runNpmDepAudit = async () => {
    throw new Error('npm-dep-audit is not available on PATH')
  }
  assert.equal(await main([], io.io, deps), 1)
  assert.equal(io.stdout, '')
  assert.match(io.stderr, /^npm-dep-upgrade-plan: npm-dep-audit is not available on PATH/)
})

function createExecutableFixture(t, report, versions, failPackage = '') {
  mkdirSync(scratchRoot, { recursive: true })
  const base = mkdtempSync(path.join(scratchRoot, 'run-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, 'project with spaces & symbols')
  const commandDirectory = path.join(base, 'fake commands')
  mkdirSync(project, { recursive: true })
  mkdirSync(commandDirectory, { recursive: true })
  writeFileSync(path.join(project, 'package.json'), '{"name":"fixture-project","version":"1.0.0"}\n')
  writeFileSync(path.join(project, 'package-lock.json'), '{"name":"fixture-project","lockfileVersion":3,"packages":{"":{}}}\n')

  const auditScript = `if (process.argv.includes('--version')) { process.stdout.write('npm-dep-audit v1.0.0\\nLocation: fixture\\n'); process.exit(0); }
const fs = require('node:fs');
if (process.env.PLAN_AUDIT_CALL_LOG) fs.appendFileSync(process.env.PLAN_AUDIT_CALL_LOG, process.argv.slice(2).join(' ') + '\\n');
const expected = ['.', '--min-severity', 'info', '--format', 'json'];
const actual = process.argv.slice(2).filter((arg, index, args) => arg !== '--no-cache' && arg !== '--cache-ttl' && args[index - 1] !== '--cache-ttl');
if (JSON.stringify(actual) !== JSON.stringify(expected)) { process.stderr.write('unexpected audit args'); process.exit(2); }
process.stdout.write(process.env.PLAN_AUDIT_JSON);
`
  const npmScript = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('12.1.0'); process.exit(0); }
if (args[0] === 'config' && args[1] === 'list') { console.log(process.env.PLAN_CONFIG_JSON || '{}'); process.exit(0); }
if (args[0] !== 'view' || !['versions', 'time'].includes(args[2]) || args[3] !== '--json') { process.stderr.write('unexpected npm args'); process.exit(2); }
const packageName = args[1];
if (args[2] === 'versions') fs.appendFileSync(process.env.PLAN_CALL_LOG, packageName + '\\n');
if (packageName === process.env.PLAN_FAIL_PACKAGE) { process.stderr.write('registry fixture failure'); process.exit(1); }
const byPackage = JSON.parse(args[2] === 'versions' ? process.env.PLAN_VERSIONS_JSON : process.env.PLAN_RELEASE_TIMES_JSON);
process.stdout.write(JSON.stringify(byPackage[packageName] ?? (args[2] === 'versions' ? [] : {})));
`
  const versionsScript = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('npm-dep-versions v' + (process.env.PLAN_VERSIONS_VERSION || '0.1.0') + '\\nLocation: fixture'); process.exit(0); }
const name = args[0];
fs.appendFileSync(process.env.PLAN_CALL_LOG, name + '\\n');
if (name === process.env.PLAN_FAIL_PACKAGE) process.exit(1);
const versions = JSON.parse(process.env.PLAN_VERSIONS_JSON)[name] || [];
const times = JSON.parse(process.env.PLAN_RELEASE_TIMES_JSON)[name] || {};
console.log(JSON.stringify({ schemaVersion: 2, package: name, fetchedAt: new Date().toISOString(), rows: versions.map(version => ({ version, releasedAt: times[version] || null })) }));
`
  writeFileSync(path.join(commandDirectory, 'fake-versions.js'), versionsScript)
  writeFileSync(path.join(commandDirectory, 'fake-paths.js'), `const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('npm-dep-paths v' + (process.env.PLAN_PATHS_VERSION || '1.0.0') + '\\nLocation: fixture'); process.exit(0); }
const at = value => ({ name: value.slice(0, value.lastIndexOf('@')), version: value.slice(value.lastIndexOf('@') + 1) });
const target = at(args[1]); const parent = at(args[args.indexOf('--upstream-of') + 1]);
console.log(JSON.stringify({ schemaVersion: 2, project: { name: 'fixture-project', version: '1.0.0' }, selector: args[1], result: { package: target.name, version: target.version, requirements: [{ declaredRequirement: '*', directDependents: [{ name: parent.name, version: parent.version, location: 'node_modules/' + parent.name, targetLocation: 'node_modules/' + target.name, type: 'dependencies', requestedName: target.name }] }] }, upstream: { selectedDependent: args[args.indexOf('--upstream-of') + 1], rootLocation: '', selectedLocations: [], targetLocations: [], topLevelLocations: [], nodes: [], edges: [] } }));`)
  writeFileSync(path.join(commandDirectory, 'fake-audit.js'), `#!/usr/bin/env node\n${auditScript}`)
  writeFileSync(path.join(commandDirectory, 'fake-npm.js'), `#!/usr/bin/env node\n${npmScript}`)

  if (process.platform === 'win32') {
    writeFileSync(path.join(commandDirectory, 'npm-dep-versions.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-versions.js" %*\r\n`)
    writeFileSync(path.join(commandDirectory, 'npm-dep-audit.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-audit.js" %*\r\n`)
    writeFileSync(path.join(commandDirectory, 'npm-dep-paths.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-paths.js" %*\r\n`)
    writeFileSync(path.join(commandDirectory, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`)
  }
  else {
    writeFileSync(path.join(commandDirectory, 'npm-dep-versions'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-versions.js" "$@"\n')
    chmodSync(path.join(commandDirectory, 'npm-dep-versions'), 0o755)
    writeFileSync(path.join(commandDirectory, 'npm-dep-audit'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-audit.js" "$@"\n')
    writeFileSync(path.join(commandDirectory, 'npm-dep-paths'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-paths.js" "$@"\n')
    chmodSync(path.join(commandDirectory, 'npm-dep-paths'), 0o755)
    writeFileSync(path.join(commandDirectory, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.js" "$@"\n')
    chmodSync(path.join(commandDirectory, 'npm-dep-audit'), 0o755)
    chmodSync(path.join(commandDirectory, 'npm'), 0o755)
  }

  const auditLog = path.join(base, 'audit-calls.txt')
  writeFileSync(auditLog, '')
  const callLog = path.join(base, 'registry-calls.txt')
  writeFileSync(callLog, '')
  const env = {
    ...process.env,
    PATH: `${commandDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    PLAN_AUDIT_JSON: JSON.stringify(report),
    PLAN_VERSIONS_JSON: JSON.stringify(versions),
    PLAN_RELEASE_TIMES_JSON: JSON.stringify({}),
    PLAN_FAIL_PACKAGE: failPackage,
    PLAN_CALL_LOG: callLog,
    PLAN_AUDIT_CALL_LOG: auditLog,
    XDG_CACHE_HOME: path.join(base, 'cache'),
  }
  const run = args => spawnSync(process.execPath, [binPath, ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 15000,
  })
  return { project, callLog, auditLog, env, run }
}

test('executable emits Markdown and JSON, distinguishes both brace-expansion links, and leaves project files unchanged', (t) => {
  const fixture = createExecutableFixture(t, braceReport(), {
    'brace-expansion': ['5.0.9', '5.0.12'],
  })
  const manifestBefore = readFileSync(path.join(fixture.project, 'package.json'))
  const lockBefore = readFileSync(path.join(fixture.project, 'package-lock.json'))

  const markdown = fixture.run([])
  assert.equal(markdown.status, 0, JSON.stringify(markdown, null, 2))
  assert.match(markdown.stdout, /node\\_modules\/nx\/node\\_modules\/brace-expansion \| none \| —/)
  assert.match(markdown.stdout, /node\\_modules\/brace-expansion \| complete \| Update within declared range \|/)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package.json')), manifestBefore)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package-lock.json')), lockBefore)

  const json = fixture.run(['--format', 'json'])
  assert.equal(json.status, 0, JSON.stringify(json, null, 2))
  const report = JSON.parse(json.stdout)
  assert.equal(report.schemaVersion, 3)
  assert.deepEqual(report.rows.map(item => [item.targetLocation, item.resolution]), [
    ['node_modules/brace-expansion', 'complete'],
    ['node_modules/nx/node_modules/brace-expansion', 'none'],
  ])
  assert.equal(report.rows[0].minimumSafeVersion, '5.0.12')
  assert.equal(report.rows[0].minimumSafeVersionReleasedAt, null)
  assert.deepEqual(report.rows[1].choices, [])
  assert.equal('advisories' in report.rows[0], false)
  assert.equal('requirements' in report.rows[0], false)
  for (const projectPath of ['.', path.join('..', path.basename(fixture.project)), fixture.project]) {
    const explicit = fixture.run(['--format', 'json', projectPath])
    assert.equal(explicit.status, 0, explicit.stderr || explicit.error?.message)
    assert.equal(explicit.stderr, '')
    assert.deepEqual(JSON.parse(explicit.stdout), report)
  }
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package.json')), manifestBefore)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package-lock.json')), lockBefore)
})

test('executable emits no partial stdout when the second registry query fails', (t) => {
  const report = braceReport()
  report.rows.push(vulnerableRow('left-pad', '1.0.1', 'low', [{
    declaredRequirement: '^1.0.0',
    directDependents: [dependent('app', '1.0.0', '', 'node_modules/left-pad')],
  }]))
  const fixture = createExecutableFixture(t, report, {
    'brace-expansion': ['5.0.9', '5.0.12'],
    'left-pad': ['1.0.1', '1.0.2'],
  }, 'left-pad')
  const result = fixture.run([])

  assert.equal(result.status, 1, JSON.stringify(result, null, 2))
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /npm-dep-upgrade-plan: npm-dep-versions failed for left-pad with exit code 1/)
  assert.deepEqual(readFileSync(fixture.callLog, 'utf8').trim().split('\n'), ['brace-expansion', 'left-pad'])
})

test('failed audit diagnostics reach stderr without a partial report', async () => {
  const io = createIo()
  const deps = injectedDeps(braceReport())
  deps.runNpmDepAudit = async () => {
    throw new Error('npm-dep-audit failed with exit code 1: Unsupported npm workspaces')
  }
  assert.equal(await main([], io.io, deps), 1)
  assert.equal(io.stdout, '')
  assert.match(io.stderr, /npm-dep-upgrade-plan: npm-dep-audit failed with exit code 1: Unsupported npm workspaces/)
})

test('planner reuses findings and forwards cache controls', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-result-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const report = { ...braceReport(), auditedAt: new Date().toISOString() }
  const deps = injectedDeps(report, new Map([['brace-expansion', ['5.0.9', '5.0.12']]]), { renderJson, renderMarkdown })
  deps.loadProject = async () => ({ root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  deps.readPlanningContext = async () => ({ npm: '12.1.0', registry: 'one', audit: 'v1', paths: 'v1' })
  const calls = []
  deps.runNpmDepAudit = async (_root, _spawn, _platform, controls) => {
    calls.push(controls)
    return report
  }
  const first = createIo()
  assert.equal(await main(['--format', 'json'], first.io, deps), 0, first.stderr)
  const second = createIo()
  assert.equal(await main([], second.io, deps), 0, second.stderr)
  assert.equal(calls.length, 1)
  assert.match(second.stdout, /brace-expansion/)
  const bypass = createIo()
  assert.equal(await main(['--no-cache', '--cache-ttl', '30m'], bypass.io, deps), 0, bypass.stderr)
  assert.deepEqual(calls[1], { noCache: true, ttlMs: 1800000 })
  deps.readPlanningContext = async () => ({ npm: '12.1.0', registry: 'two', audit: 'v1', paths: 'v1' })
  const changed = createIo()
  assert.equal(await main([], changed.io, deps), 0, changed.stderr)
  assert.equal(calls.length, 3)
})

test('separate planner processes reuse results and invalidate on files, scoped registry and sibling version', (t) => {
  const fixture = createExecutableFixture(t, { ...braceReport(), auditedAt: new Date().toISOString() }, { 'brace-expansion': ['5.0.9', '5.0.12'] })
  const first = fixture.run(['--format', 'json'])
  assert.equal(first.status, 0, first.stderr)
  const second = fixture.run(['--format', 'json'])
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout))
  assert.equal(readFileSync(fixture.callLog, 'utf8'), 'brace-expansion\n')
  assert.equal(readFileSync(fixture.auditLog, 'utf8').trim().split('\n').length, 1)
  // A project mutation invalidates the entire plan even though item IDs stay stable.
  const file = path.join(fixture.project, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.description = 'changed'
  writeFileSync(file, JSON.stringify(manifest))
  assert.equal(fixture.run([]).status, 0)
  fixture.env.PLAN_CONFIG_JSON = JSON.stringify({ '@scope:registry': 'https://other.example/' })
  assert.equal(fixture.run([]).status, 0)
  fixture.env.PLAN_PATHS_VERSION = '2.0.0'
  assert.equal(fixture.run([]).status, 0)
  assert.equal(readFileSync(fixture.callLog, 'utf8').trim().split('\n').length, 4)
  const bypass = fixture.run(['--no-cache', '--cache-ttl', '30m', '--format', 'json'])
  assert.equal(bypass.status, 0, bypass.stderr)
  assert.match(readFileSync(fixture.auditLog, 'utf8'), /--cache-ttl 1800s --no-cache/)
  const after = fixture.run(['--format', 'json'])
  assert.equal(after.status, 0, after.stderr)
  assert.equal(readFileSync(fixture.callLog, 'utf8').trim().split('\n').length, 5)
})

test('a shorter TTL refreshes a newly cached plan backed by an older audit', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-shorter-ttl-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const freshAt = new Date().toISOString()
  const oldReport = { ...braceReport(), auditedAt: new Date(Date.now() - 50 * 60000).toISOString() }
  const deps = injectedDeps(oldReport, new Map([['brace-expansion', ['5.0.9', '5.0.12']]]), { renderJson })
  deps.loadProject = async () => ({ root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  let audits = 0
  deps.runNpmDepAudit = async () => ({ ...oldReport, auditedAt: ++audits === 1 ? oldReport.auditedAt : freshAt })
  const first = createIo()
  assert.equal(await main(['--format', 'json'], first.io, deps), 0, first.stderr)
  const shorter = createIo()
  assert.equal(await main(['--format', 'json', '--cache-ttl', '30m'], shorter.io, deps), 0, shorter.stderr)
  assert.equal(audits, 2)
  assert.equal(JSON.parse(shorter.stdout).auditedAt, freshAt)
})

test('moving npm before cutoffs reuse cached plans while registry changes invalidate them', (t) => {
  const fixture = createExecutableFixture(t, { ...braceReport(), auditedAt: new Date().toISOString() }, { 'brace-expansion': ['5.0.9', '5.0.12'] })
  fixture.env.PLAN_CONFIG_JSON = JSON.stringify({ 'before': '2026-10-13T11:00:00.000Z', 'min-release-age': null, 'registry': 'https://registry.example/' })
  const first = fixture.run(['--format', 'json'])
  assert.equal(first.status, 0, first.stderr)
  fixture.env.PLAN_CONFIG_JSON = JSON.stringify({ 'before': '2026-10-13T11:00:00.100Z', 'min-release-age': null, 'registry': 'https://registry.example/' })
  const warm = fixture.run(['--format', 'json'])
  assert.equal(warm.status, 0, warm.stderr)
  assert.deepEqual(JSON.parse(warm.stdout), JSON.parse(first.stdout))
  assert.equal(readFileSync(fixture.callLog, 'utf8'), 'brace-expansion\n')
  assert.equal(readFileSync(fixture.auditLog, 'utf8').trim().split('\n').length, 1)
  fixture.env.PLAN_CONFIG_JSON = JSON.stringify({ 'before': '2026-10-13T11:00:00.200Z', 'min-release-age': null, 'registry': 'https://other.example/' })
  const changed = fixture.run(['--format', 'json'])
  assert.equal(changed.status, 0, changed.stderr)
  assert.equal(readFileSync(fixture.callLog, 'utf8').trim().split('\n').length, 2)
})

test('catalog fetch time bounds planner freshness and retains audit timestamp', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-catalog-freshness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const auditedAt = new Date().toISOString()
  const deps = injectedDeps({ ...braceReport(), auditedAt }, new Map(), { renderJson })
  deps.loadProject = async () => ({ root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  let catalogs = 0
  deps.runNpmDepVersions = async (_root, _name, _spawn, _platform, controls) => {
    catalogs++
    assert.equal(controls.noCache, false)
    return { versions: ['5.0.12'], releaseTimes: new Map(), fetchedAt: new Date(Date.now() - 50 * 60000).toISOString() }
  }
  const first = createIo()
  assert.equal(await main(['--format', 'json'], first.io, deps), 0, first.stderr)
  assert.equal(JSON.parse(first.stdout).auditedAt, auditedAt)
  const shorter = createIo()
  assert.equal(await main(['--format', 'json', '--cache-ttl', '30m'], shorter.io, deps), 0, shorter.stderr)
  assert.equal(catalogs, 2)
})

test('planner result expires at the oldest catalog boundary rather than its creation time', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-expiry-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let clock = Date.now()
  const auditTime = new Date(clock).toISOString()
  const catalogTime = new Date(clock - 30 * 60000).toISOString()
  t.mock.method(Date, 'now', () => clock)
  const deps = injectedDeps({ ...braceReport(), auditedAt: auditTime })
  deps.loadProject = async () => ({ root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  let calls = 0
  deps.runNpmDepVersions = async () => {
    calls++
    return { versions: [], releaseTimes: new Map(), fetchedAt: catalogTime }
  }
  assert.equal(await main([], createIo().io, deps), 0)
  clock += 30 * 60000 - 1
  assert.equal(await main([], createIo().io, deps), 0)
  assert.equal(calls, 1)
  clock++
  assert.equal(await main([], createIo().io, deps), 0)
  assert.equal(calls, 2)
})

function twoPackageReport() {
  const report = { ...braceReport(), auditedAt: new Date().toISOString() }
  report.rows.push(vulnerableRow('other-package', '1.0.0', 'high', [{ declaredRequirement: '1.0.0', directDependents: [dependent('app-parent', '1.0.0', 'node_modules/app-parent', 'node_modules/other-package')] }]))
  return report
}

test('--clear-cache clears once before reading cache and forwards to audit and every versions call', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-clear-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const events = []
  const controlsSeen = []
  const deps = injectedDeps(twoPackageReport(), new Map(), { renderJson })
  deps.loadProject = async () => ({ root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  deps.clearCache = async (options) => {
    events.push(['clear', options.tool])
  }
  deps.readPlanningContext = async () => {
    events.push(['context'])
    return { fixture: true }
  }
  deps.runNpmDepAudit = async (_root, _spawn, _platform, controls) => {
    controlsSeen.push(['audit', controls])
    return twoPackageReport()
  }
  deps.runNpmDepVersions = async (_root, name, _spawn, _platform, controls) => {
    controlsSeen.push([name, controls])
    return { versions: [], releaseTimes: new Map(), fetchedAt: new Date().toISOString() }
  }
  const io = createIo()
  assert.equal(await main(['/project', '--clear-cache', '--format', 'json'], io.io, deps), 0, io.stderr)
  assert.deepEqual(events, [['clear', 'npm-dep-upgrade-plan'], ['context']])
  assert.deepEqual(controlsSeen.map(([name]) => name).sort(), ['audit', 'brace-expansion', 'other-package'])
  assert.ok(controlsSeen.every(([, controls]) => controls.clearCache === true))
})

test('no child call carries a clear request without --clear-cache', async () => {
  const controlsSeen = []
  const deps = injectedDeps(twoPackageReport(), new Map(), { renderJson })
  deps.clearCache = () => assert.fail('must not clear')
  deps.loadProject = async () => ({ root: path.join(scratchRoot, 'no-clear'), manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  deps.runNpmDepAudit = async (_root, _spawn, _platform, controls) => {
    controlsSeen.push(controls)
    return twoPackageReport()
  }
  deps.runNpmDepVersions = async (_root, _name, _spawn, _platform, controls) => {
    controlsSeen.push(controls)
    return { versions: [], releaseTimes: new Map(), fetchedAt: new Date().toISOString() }
  }
  assert.equal(await main(['--no-cache', '--format', 'json'], createIo().io, deps), 0)
  assert.equal(controlsSeen.length, 3)
  assert.ok(controlsSeen.every(controls => !Object.hasOwn(controls, 'clearCache')))
})

test('--clear-cache does not delete anything for --help or --version', async () => {
  const deps = { clearCache: () => assert.fail('must not clear') }
  const help = createIo()
  assert.equal(await main(['--clear-cache', '--help'], help.io, deps), 0)
  assert.match(help.stdout, /^ {2}--clear-cache {2,}Delete this tool's and its sibling tools' caches; with no project, only clear$/m)
  assert.equal(await main(['--clear-cache', '--version'], createIo().io, deps), 0)
})

test('a cache that cannot be cleared exits 1 before any child tool runs', async () => {
  const deps = injectedDeps(twoPackageReport())
  deps.clearCache = async () => {
    throw new Error('EACCES: cannot clear')
  }
  deps.runNpmDepAudit = () => assert.fail('must not run audit')
  const io = createIo()
  assert.equal(await main(['/project', '--clear-cache'], io.io, deps), 1)
  assert.equal(io.stdout, '')
  assert.equal(io.stderr, 'npm-dep-upgrade-plan: EACCES: cannot clear\n')
})

test('a child failure while clearing is fatal and leaves stdout empty', async () => {
  const deps = injectedDeps(twoPackageReport())
  deps.clearCache = async () => {}
  deps.runNpmDepAudit = async () => {
    throw new Error('npm-dep-audit failed with exit code 1: cannot clear cache')
  }
  const io = createIo()
  assert.equal(await main(['/project', '--clear-cache', '--no-cache'], io.io, deps), 1)
  assert.equal(io.stdout, '')
  assert.match(io.stderr, /npm-dep-upgrade-plan: npm-dep-audit failed with exit code 1: cannot clear cache/)
})

test('--clear-cache without a project clears this tool, audit and versions with no analysis', async () => {
  const events = []
  const deps = {
    clearCache: async (options) => {
      events.push(['clear', options.tool])
    },
    clearNpmDepAuditCache: async () => {
      events.push(['clear audit'])
    },
    clearNpmDepVersionsCache: async () => {
      events.push(['clear versions'])
    },
    loadProject: () => assert.fail('must not load a project'),
    runNpmDepAudit: () => assert.fail('must not audit'),
  }
  const io = createIo()
  assert.equal(await main(['--clear-cache', '--format', 'json'], io.io, deps), 0, io.stderr)
  assert.deepEqual(events, [['clear', 'npm-dep-upgrade-plan'], ['clear audit'], ['clear versions']])
  assert.equal(io.stdout, '')
})

test('a failing child clear in clear-only mode exits 1 with an empty stdout', async () => {
  const deps = {
    clearCache: async () => {},
    clearNpmDepAuditCache: async () => {
      throw new Error('npm-dep-audit --clear-cache failed with exit code 1: EACCES')
    },
    clearNpmDepVersionsCache: () => assert.fail('must stop after the failing child'),
  }
  const io = createIo()
  assert.equal(await main(['--clear-cache'], io.io, deps), 1)
  assert.equal(io.stdout, '')
  assert.match(io.stderr, /^npm-dep-upgrade-plan: npm-dep-audit --clear-cache failed/)
})

function parentReport() {
  const requirement = (spec, name, version) => ({ declaredRequirement: spec, directDependents: [{ name, version, location: `node_modules/${name}`, targetLocation: 'node_modules/brace-expansion', type: 'dependencies', requestedName: 'brace-expansion' }] })
  return { schemaVersion: 2, auditedAt: new Date().toISOString(), rows: [vulnerableRow('brace-expansion', '5.0.9', 'high', [requirement('5.0.9', 'nx', '23.1.2'), requirement('^5.0.5', 'plain', '1.0.0')])] }
}

function parentDeps(calls) {
  const deps = injectedDeps(parentReport(), new Map(), { renderJson: findings => JSON.stringify(findings) })
  deps.loadProject = async () => ({ root: path.join(scratchRoot, 'parent-flow'), manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  deps.clearCache = async () => {}
  deps.runNpmDepVersions = async (_root, name, _spawn, _platform, controls) => {
    calls.versions.push([name, controls])
    return { versions: name === 'brace-expansion' ? ['5.0.9', '5.0.12'] : ['23.1.2', '23.2.0'], releaseTimes: new Map([['23.2.0', '2026-10-01T00:00:00.000Z']]), fetchedAt: new Date().toISOString() }
  }
  deps.readReleasePolicy = async () => ({ minAgeDays: 7, cutoffMs: null })
  deps.readUpstream = async (root, target, parents, controls) => {
    calls.upstream.push({ target, parents, controls })
    return { nodes: new Map([['', { location: '', name: 'app', version: '1.0.0' }], ['node_modules/nx', { location: 'node_modules/nx', name: 'nx', version: '23.1.2' }]]), edges: [{ from: '', to: 'node_modules/nx', requestedName: 'nx', type: 'dependencies', spec: '^23.0.0' }] }
  }
  deps.resolveChoices = async (_project, _item, choices) => {
    calls.resolves.push(choices.map(c => `${c.targetPackage}@${c.targetVersion}`))
    const parent = choices.find(c => c.strategy === 'upgrade-via-parent-dependency')
    const cleared = [{ location: 'node_modules/plain', requestedName: 'brace-expansion', type: 'dependencies' }, ...(parent ? [{ location: 'node_modules/nx', requestedName: 'brace-expansion', type: 'dependencies' }] : [])]
    return { choices, graph: { nodes: [], edges: [] }, coverage: { resolution: parent ? 'complete' : 'partial', clearedConsumers: cleared, remainingConsumers: [] }, freshAt: Date.now() }
  }
  return deps
}

test('a partially resolved finding gains a parent upgrade and the resolution comes from the joint resolution', async () => {
  const calls = { versions: [], upstream: [], resolves: [] }
  const io = createIo()
  assert.equal(await main(['/project', '--no-cache', '--format', 'json'], io.io, parentDeps(calls)), 0, io.stderr)
  const [finding] = JSON.parse(io.stdout)
  assert.equal(finding.resolution, 'complete')
  assert.deepEqual(finding.choices.map(c => `${c.strategy}:${c.targetPackage}@${c.targetVersion}`), [
    'update-within-declared-range:brace-expansion@5.0.12',
    'upgrade-via-parent-dependency:nx@23.2.0',
  ])
  assert.deepEqual(calls.upstream[0].parents, [{ name: 'nx', version: '23.1.2' }])
  assert.deepEqual(calls.upstream[0].target, { package: 'brace-expansion', version: '5.0.9' })
  assert.equal(calls.versions.filter(([name]) => name === 'brace-expansion').length, 1, 'the audited package catalog is reused')
  assert.deepEqual(calls.versions.filter(([name]) => name === 'nx').length, 1)
})

test('bypass and clear requests reach every new sibling call', async () => {
  const calls = { versions: [], upstream: [], resolves: [] }
  const io = createIo()
  assert.equal(await main(['/project', '--no-cache', '--clear-cache', '--format', 'json'], io.io, parentDeps(calls)), 0, io.stderr)
  assert.deepEqual(calls.upstream[0].controls, { noCache: true, clearCache: true })
  const nx = calls.versions.find(([name]) => name === 'nx')[1]
  assert.equal(nx.noCache, true)
  assert.equal(nx.clearCache, true)
})

test('a failing paths query is fatal and leaves stdout empty', async () => {
  const calls = { versions: [], upstream: [], resolves: [] }
  const deps = parentDeps(calls)
  deps.readUpstream = async () => {
    throw new Error('npm-dep-paths failed for brace-expansion@5.0.9')
  }
  const io = createIo()
  assert.equal(await main(['/project', '--no-cache'], io.io, deps), 1)
  assert.equal(io.stdout, '')
  assert.match(io.stderr, /npm-dep-upgrade-plan: npm-dep-paths failed/)
})

test('ancestor catalog freshness bounds the cached plan', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-parent-fresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = { versions: [], upstream: [], resolves: [] }
  const deps = parentDeps(calls)
  deps.loadProject = async () => ({ root, manifestBytes: Buffer.from('{}'), lockBytes: Buffer.from('{}') })
  deps.readPlanningContext = async () => ({ fixture: 'parent-fresh' })
  const inner = deps.runNpmDepVersions
  deps.runNpmDepVersions = async (...args) => {
    const catalog = await inner(...args)
    return args[1] === 'nx' ? { ...catalog, fetchedAt: new Date(Date.now() - 50 * 60000).toISOString() } : catalog
  }
  assert.equal(await main(['/project', '--format', 'json'], createIo().io, deps), 0)
  const before = calls.versions.length
  assert.equal(await main(['/project', '--format', 'json', '--cache-ttl', '30m'], createIo().io, deps), 0)
  assert.ok(calls.versions.length > before, 'a shorter TTL refreshes because the oldest source is too old')
})
