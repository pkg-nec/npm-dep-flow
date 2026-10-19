import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.js'

const tempRoot = process.env.NPM_DEP_PATHS_TEST_TMPDIR || tmpdir()

async function fixture(t, parents = 2, twoVersions = true) {
  const dir = await mkdtemp(join(tempRoot, 'npm-dep-paths-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dependencies = {}
  const packages = { '': { name: 'app', version: '1.0.0', dependencies } }
  for (let i = 0; i < parents; i++) {
    const name = `parent-${String(i).padStart(4, '0')}`
    dependencies[name] = '1.0.0'
    packages[`node_modules/${name}`] = { version: '1.0.0', dependencies: { dep: i === 0 ? '^5.0.5' : '5.0.9' } }
  }
  packages['node_modules/dep'] = { version: '5.0.9' }
  if (twoVersions) {
    dependencies.old = '1.0.0'
    packages['node_modules/old'] = { version: '1.0.0', dependencies: { dep: '^2' } }
    packages['node_modules/old/node_modules/dep'] = { version: '2.1.7' }
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies }))
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, packages }))
  return dir
}

function capture() {
  let stdout = ''
  let stderr = ''
  return { io: { stdout: { write: value => { stdout += value } }, stderr: { write: value => { stderr += value } } }, get stdout() { return stdout }, get stderr() { return stderr } }
}

test('name and exact queries return schema v2 requirement summaries', async t => {
  const dir = await fixture(t)
  const all = capture()
  assert.equal(await main([dir, 'dep', '--format', 'json'], all.io), 0)
  const allData = JSON.parse(all.stdout)
  assert.equal(allData.schemaVersion, 2)
  assert.deepEqual(allData.results.map(item => item.version), ['2.1.7', '5.0.9'])
  assert.deepEqual(allData.results[1].requirements.map(item => item.declaredRequirement), ['5.0.9', '^5.0.5'])
  assert.equal(Object.hasOwn(allData.results[1], 'routes'), false)
  const exact = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json'], exact.io), 0)
  assert.equal(JSON.parse(exact.stdout).result.version, '5.0.9')
  assert.equal(Object.hasOwn(JSON.parse(exact.stdout), 'results'), false)
  const human = capture()
  assert.equal(await main([dir, 'dep@5.0.9'], human.io), 0)
  assert.match(human.stdout, /^\| Declared requirement \| Direct dependents \|$/m)
  assert.match(human.stdout, /^\| \^5\.0\.5 \| parent-0000@1\.0\.0/m)
})

test('upstream JSON keeps the summary and --from filters only its graph', async t => {
  const dir = await fixture(t)
  const normal = capture()
  const detailed = capture()
  const focused = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json'], normal.io), 0)
  assert.equal(await main([dir, 'dep@5.0.9', '--upstream-of', 'parent-0000@1.0.0', '--format', 'json'], detailed.io), 0)
  assert.equal(await main([dir, 'dep@5.0.9', '--upstream-of', 'parent-0000@1.0.0', '--from', 'parent-0000@1.0.0', '--format', 'json'], focused.io), 0)
  const normalData = JSON.parse(normal.stdout)
  const detailedData = JSON.parse(detailed.stdout)
  const focusedData = JSON.parse(focused.stdout)
  assert.deepEqual(detailedData.result, normalData.result)
  assert.deepEqual(focusedData.result, normalData.result)
  assert.deepEqual(detailedData.upstream.topLevelLocations, ['node_modules/parent-0000'])
  assert.deepEqual(focusedData.upstream.nodes.map(item => item.location), ['', 'node_modules/dep', 'node_modules/parent-0000'])
  assert.equal(focusedData.upstream.edges.at(-1).spec, '^5.0.5')
})

test('text upstream overview and focused graph show requirements', async t => {
  const dir = await fixture(t)
  const overview = capture()
  const focused = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--upstream-of', 'parent-0000@1.0.0'], overview.io), 0)
  assert.match(overview.stdout, /Immediate parents \(1\):/)
  assert.match(overview.stdout, /Top-level packages \(1\):/)
  assert.match(overview.stdout, /requires dep@5\.0\.9: \^5\.0\.5/)
  assert.equal(await main([dir, 'dep@5.0.9', '--upstream-of', 'parent-0000@1.0.0', '--from', 'parent-0000@1.0.0'], focused.io), 0)
  assert.match(focused.stdout, /app@1\.0\.0[\s\S]*parent-0000@1\.0\.0[\s\S]*dep@5\.0\.9/)
})

test('help and invalid requests never emit a partial report', async t => {
  const dir = await fixture(t)
  const help = capture()
  assert.equal(await main(['--help'], help.io), 0)
  assert.match(help.stdout, /--upstream-of/)
  assert.match(help.stdout, /--from/)
  for (const args of [
    [], [dir], [dir, 'dep', '--wat'], [dir, 'dep', '--format', 'xml'], [dir, 'dep@9.9.9'], [dir, 'dep@^5'],
    [dir, 'dep@5.0.9', '--from', 'parent-0000@1.0.0'],
    [dir, 'dep', '--upstream-of', 'parent-0000@1.0.0'],
    [dir, 'dep@5.0.9', '--upstream-of', 'parent-0000'],
    [dir, 'dep@5.0.9', '--upstream-of', 'old@1.0.0'],
    [dir, 'dep@5.0.9', '--upstream-of', 'parent-0000@1.0.0', '--from', 'old@1.0.0'],
  ]) {
    const output = capture()
    assert.equal(await main(args, output.io), 1, args.join(' '))
    assert.equal(output.stdout, '')
    assert.match(output.stderr, /npm-dep-paths:/)
  }
  const none = capture()
  assert.equal(await main([dir, 'absent', '--format', 'json'], none.io), 0)
  assert.deepEqual(JSON.parse(none.stdout).results, [])
})

test('real executable emits a complete compact summary without node_modules', async t => {
  const dir = await fixture(t, 1025, false)
  const bin = fileURLToPath(new URL('../bin/npm-dep-paths.js', import.meta.url))
  const child = spawn(process.execPath, [bin, dir, 'dep@5.0.9', '--format', 'json'], { env: process.env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  assert.equal(status, 0, stderr)
  const result = JSON.parse(stdout).result
  assert.deepEqual(result.requirements.map(item => item.declaredRequirement), ['5.0.9', '^5.0.5'])
  assert.equal(result.requirements[0].directDependents.length, 1024)
  assert.equal(result.requirements[0].directDependents.at(-1).name, 'parent-1024')
  assert.ok(Buffer.byteLength(stdout) < 500000)
})
