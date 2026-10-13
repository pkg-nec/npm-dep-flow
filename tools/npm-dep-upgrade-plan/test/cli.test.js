import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { main } from '../src/cli.js'
import { renderJson, renderMarkdown } from '../src/report.js'

const scratchRoot = '/home/maw/src/nrc/npm-dep-flow-impl/tmp/npm-dep-upgrade-plan-cli'
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
      stdout: { write(value) { stdout += value } },
      stderr: { write(value) { stderr += value } },
    },
    get stdout() { return stdout },
    get stderr() { return stderr },
  }
}

function injectedDeps(report, versions = new Map(), renderers = {}) {
  return {
    async runNpmDepAudit(projectRoot) { return report },
    async fetchStableVersions(projectRoot, packageName) { return versions.get(packageName) ?? [] },
    async fetchReleaseTimes() { return new Map() },
    renderMarkdown: renderers.renderMarkdown ?? (() => 'markdown report\n'),
    renderJson: renderers.renderJson ?? (() => '{"schemaVersion":1}\n'),
  }
}

test('help short-circuits invalid arguments and does not run subprocess adapters', async () => {
  let calls = 0
  const io = createIo()
  const deps = {
    async runNpmDepAudit() { calls += 1; throw new Error('must not run') },
    async fetchStableVersions() { calls += 1; throw new Error('must not run') },
    renderMarkdown() { calls += 1; return '' },
    renderJson() { calls += 1; return '' },
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
    renderMarkdown(rows) { calls.push(['markdown', rows]); return 'markdown report\n' },
  })
  const originalAudit = deps.runNpmDepAudit
  deps.runNpmDepAudit = async root => { calls.push(['audit', root]); return originalAudit(root) }

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
    renderJson(rows, auditedAt) { calls.push(['json', rows, auditedAt]); return renderJson(rows, auditedAt) },
  })
  deps.runNpmDepAudit = async root => { calls.push(['audit', root]); return report }

  assert.equal(await main(['./fixture', '--format', 'json'], io.io, deps), 0)
  assert.deepEqual(calls, [
    ['audit', path.resolve('./fixture')],
    ['json', [], '2026-10-13T06:00:00.000Z'],
  ])
  assert.deepEqual(JSON.parse(io.stdout), {
    schemaVersion: 2,
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
  deps.runNpmDepAudit = async () => { calls.audit += 1; return report }
  deps.fetchStableVersions = async (root, packageName) => { calls.registry.push(packageName); return [] }

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
  deps.fetchStableVersions = async () => { registryCalls += 1; return [] }

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
  assert.match(io.stdout, /node\\_modules\/nx\/node\\_modules\/brace-expansion \| ineligible \| —/)
  assert.match(io.stdout, /node\\_modules\/brace-expansion \| eligible \| Update within declared range: brace-expansion@5\.0\.9 → brace-expansion@5\.0\.12/)
})

test('main returns success when all links are ineligible', async () => {
  const io = createIo()
  const report = braceReport()
  const result = await main([], io.io, injectedDeps(report, new Map([
    ['brace-expansion', ['5.0.9', '5.0.12']],
  ]), { renderMarkdown }))

  assert.equal(result, 0)
  assert.match(io.stdout, /\| ineligible \| — \|/)
  assert.equal(io.stderr, '')
})

test('main leaves stdout empty when the audit command fails', async () => {
  const io = createIo()
  const deps = injectedDeps({ rows: [] })
  deps.runNpmDepAudit = async () => { throw new Error('npm-dep-audit is not available on PATH') }
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
  writeFileSync(path.join(project, 'package-lock.json'), '{"name":"fixture-project","lockfileVersion":3,"packages":{}}\n')

  const auditScript = `const expected = ['.', '--min-severity', 'info', '--format', 'json'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) { process.stderr.write('unexpected audit args'); process.exit(2); }
process.stdout.write(process.env.PLAN_AUDIT_JSON);
`
  const npmScript = `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'view' || !['versions', 'time'].includes(args[2]) || args[3] !== '--json') { process.stderr.write('unexpected npm args'); process.exit(2); }
const packageName = args[1];
if (args[2] === 'versions') fs.appendFileSync(process.env.PLAN_CALL_LOG, packageName + '\\n');
if (packageName === process.env.PLAN_FAIL_PACKAGE) { process.stderr.write('registry fixture failure'); process.exit(1); }
const byPackage = JSON.parse(args[2] === 'versions' ? process.env.PLAN_VERSIONS_JSON : process.env.PLAN_RELEASE_TIMES_JSON);
process.stdout.write(JSON.stringify(byPackage[packageName] ?? (args[2] === 'versions' ? [] : {})));
`
  writeFileSync(path.join(commandDirectory, 'fake-audit.js'), `#!/usr/bin/env node\n${auditScript}`)
  writeFileSync(path.join(commandDirectory, 'fake-npm.js'), `#!/usr/bin/env node\n${npmScript}`)

  if (process.platform === 'win32') {
    writeFileSync(path.join(commandDirectory, 'npm-dep-audit.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-audit.js" %*\r\n`)
    writeFileSync(path.join(commandDirectory, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`)
  } else {
    writeFileSync(path.join(commandDirectory, 'npm-dep-audit'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-audit.js" "$@"\n')
    writeFileSync(path.join(commandDirectory, 'npm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-npm.js" "$@"\n')
    chmodSync(path.join(commandDirectory, 'npm-dep-audit'), 0o755)
    chmodSync(path.join(commandDirectory, 'npm'), 0o755)
  }

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
  }
  const run = args => spawnSync(process.execPath, [binPath, ...args], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 15000,
  })
  return { project, callLog, run }
}

test('executable emits Markdown and JSON, distinguishes both brace-expansion links, and leaves project files unchanged', t => {
  const fixture = createExecutableFixture(t, braceReport(), {
    'brace-expansion': ['5.0.9', '5.0.12'],
  })
  const manifestBefore = readFileSync(path.join(fixture.project, 'package.json'))
  const lockBefore = readFileSync(path.join(fixture.project, 'package-lock.json'))

  const markdown = fixture.run([])
  assert.equal(markdown.status, 0, JSON.stringify(markdown, null, 2))
  assert.match(markdown.stdout, /node\\_modules\/nx\/node\\_modules\/brace-expansion \| ineligible \| —/)
  assert.match(markdown.stdout, /node\\_modules\/brace-expansion \| eligible \| Update within declared range: brace-expansion@5\.0\.9 → brace-expansion@5\.0\.12/)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package.json')), manifestBefore)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package-lock.json')), lockBefore)

  const json = fixture.run(['--format', 'json'])
  assert.equal(json.status, 0, JSON.stringify(json, null, 2))
  const report = JSON.parse(json.stdout)
  assert.equal(report.schemaVersion, 2)
  assert.deepEqual(report.rows.map(item => [item.targetLocation, item.status]), [
    ['node_modules/brace-expansion', 'eligible'],
    ['node_modules/nx/node_modules/brace-expansion', 'ineligible'],
  ])
  assert.equal(report.rows[0].minimumSafeVersion, '5.0.12')
  assert.equal(report.rows[0].minimumSafeVersionReleasedAt, null)
  assert.equal(report.rows[1].strategy, null)
  assert.equal('advisories' in report.rows[0], false)
  assert.equal('requirements' in report.rows[0], false)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package.json')), manifestBefore)
  assert.deepEqual(readFileSync(path.join(fixture.project, 'package-lock.json')), lockBefore)
})

test('executable emits no partial stdout when the second registry query fails', t => {
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
  assert.match(result.stderr, /npm-dep-upgrade-plan: npm view failed for left-pad with exit code 1/)
  assert.deepEqual(readFileSync(fixture.callLog, 'utf8').trim().split('\n'), ['brace-expansion', 'left-pad'])
})
