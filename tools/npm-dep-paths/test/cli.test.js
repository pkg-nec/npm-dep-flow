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

test('name query returns grouped versions and exact query returns one version', async t => {
  const dir = await fixture(t)
  const all = capture()
  assert.equal(await main([dir, 'dep', '--format', 'json'], all.io), 0)
  assert.deepEqual(JSON.parse(all.stdout).results.map(item => [item.version, item.routeCount]), [['2.1.7', 1], ['5.0.9', 2]])
  const exact = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json'], exact.io), 0)
  assert.equal(JSON.parse(exact.stdout).result.routeCount, 2)
  assert.equal(Object.hasOwn(JSON.parse(exact.stdout), 'results'), false)
  const human = capture()
  assert.equal(await main([dir, 'dep@5.0.9'], human.io), 0)
  assert.match(human.stdout, /dep@5\.0\.9 — 2 routes/)
  assert.match(human.stdout, /\[dependency: \^5\.0\.5\]/)
})

test('help and invalid requests never emit a partial report', async t => {
  const dir = await fixture(t)
  const help = capture()
  assert.equal(await main(['--help'], help.io), 0)
  assert.match(help.stdout, /--format text\|json/)
  for (const args of [[], [dir], [dir, 'dep', '--wat'], [dir, 'dep', '--format', 'xml'], [dir, 'dep@9.9.9'], [dir, 'dep@^5']]) {
    const output = capture()
    assert.equal(await main(args, output.io), 1, args.join(' '))
    assert.equal(output.stdout, '')
    assert.match(output.stderr, /npm-dep-paths:/)
  }
  const none = capture()
  assert.equal(await main([dir, 'absent', '--format', 'json'], none.io), 0)
  assert.deepEqual(JSON.parse(none.stdout).results, [])
})

test('real executable streams a complete large report without node_modules', async t => {
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
  assert.equal(result.routeCount, 1025)
  assert.equal(result.routes.at(-1)[1].name, 'parent-1024')
})
