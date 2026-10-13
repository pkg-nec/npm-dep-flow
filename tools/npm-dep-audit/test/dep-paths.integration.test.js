import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProject } from '../src/project.js'
import { runNpmDepPaths } from '../src/dep-paths.js'
import { main } from '../src/cli.js'

const enabled = process.env.NPM_DEP_PATHS_INTEGRATION === '1'

test('audit consumes the separately installed npm-dep-paths CLI', { skip: !enabled }, async t => {
  const temporaryRoot = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'npm-dep-audit-paths-integration-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const manifest = {
    name: 'fixture', version: '1.0.0', dependencies: { 'brace-expansion': '5.0.9' },
  }
  const lock = {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { 'brace-expansion': '5.0.9' } },
      'node_modules/brace-expansion': { version: '5.0.9' },
    },
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))

  const audit = {
    auditReportVersion: 2,
    metadata: { vulnerabilities: { total: 1 } },
    vulnerabilities: {
      'brace-expansion': {
        name: 'brace-expansion', severity: 'high',
        via: [{ source: 1, title: 'Fixture advisory', url: 'https://example.test/advisory', severity: 'high', range: '<6' }],
        nodes: ['node_modules/brace-expansion'],
      },
    },
  }
  const deps = {
    loadProject,
    readNpmContext: async () => ({ version: '12.1.0', registry: 'https://registry.example/' }),
    getAudit: async () => ({ audit, auditedAt: '2026-10-13T00:00:00.000Z' }),
    runNpmDepPaths,
  }
  const createIo = () => {
    let stdout = ''
    let stderr = ''
    return {
      io: {
        stdout: { write: value => { stdout += value } },
        stderr: { write: value => { stderr += value } },
      },
      get stdout() { return stdout },
      get stderr() { return stderr },
    }
  }

  const markdown = createIo()
  assert.equal(await main([root], markdown.io, deps), 0, markdown.stderr)
  assert.match(markdown.stdout, /5\.0\.9 → fixture@1\.0\.0 \[dependencies\]/)

  const json = createIo()
  assert.equal(await main([root, '--format', 'json'], json.io, deps), 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.schemaVersion, 2)
  assert.equal(Object.hasOwn(report.rows[0], 'paths'), false)
  assert.deepEqual(report.rows[0].requirements.map(group => group.declaredRequirement), ['5.0.9'])
  assert.deepEqual(report.rows[0].requirements[0].directDependents.map(dependent => [dependent.name, dependent.version, dependent.type]), [
    ['fixture', '1.0.0', 'dependencies'],
  ])
})
