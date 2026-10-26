import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.js'
import { loadProject } from '../src/project.js'

const tempRoot = process.env.NPM_DEP_PATHS_TEST_TMPDIR || tmpdir()

async function fixture(t, parents = 2, twoVersions = true, packageName = 'dep') {
  const dir = await mkdtemp(join(tempRoot, 'npm-dep-paths-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dependencies = {}
  const packages = { '': { name: 'app', version: '1.0.0', dependencies } }
  for (let i = 0; i < parents; i++) {
    const name = `parent-${String(i).padStart(4, '0')}`
    dependencies[name] = '1.0.0'
    packages[`node_modules/${name}`] = { version: '1.0.0', dependencies: { [packageName]: i === 0 ? '^5.0.5' : '5.0.9' } }
  }
  packages[`node_modules/${packageName}`] = { version: '5.0.9' }
  if (twoVersions) {
    dependencies.old = '1.0.0'
    packages['node_modules/old'] = { version: '1.0.0', dependencies: { [packageName]: '^2' } }
    packages[`node_modules/old/node_modules/${packageName}`] = { version: '2.1.7' }
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies }))
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, packages }))
  return dir
}

function capture() {
  let stdout = ''
  let stderr = ''
  return { io: { stdout: { write: (value) => {
    stdout += value
  } }, stderr: { write: (value) => {
    stderr += value
  } } }, get stdout() {
    return stdout
  }, get stderr() {
    return stderr
  } }
}

test('name and exact queries return schema v2 requirement summaries', async (t) => {
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

test('upstream JSON keeps the summary and --from filters only its graph', async (t) => {
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

test('text upstream overview and focused graph show requirements', async (t) => {
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

test('help and invalid requests never emit a partial report', async (t) => {
  const dir = await fixture(t)
  const help = capture()
  assert.equal(await main(['--help'], help.io), 0)
  assert.match(help.stdout, /--upstream-of/)
  assert.match(help.stdout, /--from/)
  for (const args of [
    [], ['--format', 'json'], [dir], [dir, 'dep', 'extra'], [dir, 'dep', '--format'], [dir, 'dep', '--upstream-of'], [dir, 'dep', '--wat'], [dir, 'dep', '--format', 'xml'], [dir, 'dep@9.9.9'], [dir, 'dep@^5'],
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

test('real executable emits a complete compact summary without node_modules', async (t) => {
  const dir = await fixture(t, 1025, false)
  const bin = fileURLToPath(new URL('../bin/npm-dep-paths.js', import.meta.url))
  const child = spawn(process.execPath, [bin, dir, 'dep@5.0.9', '--format', 'json'], { env: process.env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
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

test('Markdown default and text alias preserve summaries with safely fenced upstream detail', async (t) => {
  const dir = await fixture(t)
  for (const extra of [[], ['--upstream-of', 'parent-0000@1.0.0'], ['--upstream-of', 'parent-0000@1.0.0', '--from', 'parent-0000@1.0.0']]) {
    const outputs = []
    for (const format of [[], ['--format', 'markdown'], ['--format', 'text']]) {
      const output = capture()
      assert.equal(await main([dir, 'dep@5.0.9', ...extra, ...format], output.io), 0, output.stderr)
      outputs.push(output.stdout)
    }
    assert.equal(outputs[0], outputs[1])
    assert.equal(outputs[0], outputs[2])
    assert.equal(outputs[0].match(/^# /gm).length, 1)
    if (extra.length) assert.match(outputs[0], /\n\n```text\n[\s\S]+\n```\n$/)
  }
  const manifestPath = join(dir, 'package.json')
  const lockPath = join(dir, 'package-lock.json')
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  manifest.name = lock.packages[''].name = 'app```name'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(lockPath, JSON.stringify(lock))
  const output = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--upstream-of', 'parent-0000@1.0.0', '--from', 'parent-0000@1.0.0'], output.io), 0, output.stderr)
  assert.match(output.stdout, /\n````text\napp```name@1.0.0[\s\S]+\n````\n$/)
})

test('executable defaults to the caller directory with flags first and preserves explicit paths', async (t) => {
  const bin = fileURLToPath(new URL('../bin/npm-dep-paths.js', import.meta.url))
  for (const name of ['dep', '@scope/dep']) {
    const dir = await fixture(t, 2, true, name)
    for (const selector of [name, `${name}@5.0.9`]) {
      for (const args of [
        [selector, '--format', 'json'],
        ['--format', 'json', selector],
        ['--format', 'json', '.', selector],
        [join('..', basename(dir)), selector, '--format', 'json'],
        [dir, selector, '--format', 'json'],
      ]) {
        const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
        assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error?.message}`)
        assert.equal(result.stderr, '')
        const report = JSON.parse(result.stdout)
        assert.equal(report.schemaVersion, 2)
        assert.deepEqual(report.project, { name: 'app', version: '1.0.0' })
        assert.equal(report.selector, selector)
        if (selector === name) {
          assert.deepEqual(report.results.map(item => item.version), ['2.1.7', '5.0.9'])
        }
        else {
          assert.equal(report.result.version, '5.0.9')
          assert.deepEqual(report.result.requirements.map(item => item.declaredRequirement), ['5.0.9', '^5.0.5'])
        }
      }
    }
    const markdown = spawnSync(process.execPath, [bin, name], { cwd: dir, encoding: 'utf8' })
    assert.equal(markdown.status, 0, markdown.stderr)
    assert.match(markdown.stdout, /^# npm-dep-paths/m)
    const upstream = spawnSync(process.execPath, [bin, '--format', 'json', `${name}@5.0.9`, '--upstream-of', 'parent-0000@1.0.0', '--from', 'parent-0000@1.0.0'], { cwd: dir, encoding: 'utf8' })
    assert.equal(upstream.status, 0, upstream.stderr)
    assert.deepEqual(JSON.parse(upstream.stdout).upstream.topLevelLocations, ['node_modules/parent-0000'])
  }
})

test('cached queries skip graph construction, share formats, and bypass on request', async (t) => {
  const dir = await fixture(t)
  const { buildGraph } = await import('../src/graph.js')
  let builds = 0
  const deps = {
    ...await import('../src/project.js'), ...await import('../src/selector.js'),
    ...await import('../src/summary.js'), ...await import('../src/upstream.js'),
    ...await import('../src/report.js'),
    buildGraph(project) {
      builds++
      return buildGraph(project)
    },
  }
  for (const format of ['json', 'markdown', 'text']) {
    const output = capture()
    assert.equal(await main([dir, 'dep', '--format', format], output.io, deps), 0, output.stderr)
  }
  assert.equal(builds, 1)
  const fresh = capture()
  assert.equal(await main([dir, 'dep', '--no-cache', '--format', 'json'], fresh.io, deps), 0, fresh.stderr)
  assert.equal(builds, 2)
  const other = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json'], other.io, deps), 0, other.stderr)
  assert.equal(builds, 3)
  const { readFile } = await import('node:fs/promises')
  const lockPath = join(dir, 'package-lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.packages['node_modules/dep'].version = '5.0.10'
  await writeFile(lockPath, JSON.stringify(lock))
  const changed = capture()
  assert.equal(await main([dir, 'dep', '--format', 'json'], changed.io, deps), 0, changed.stderr)
  assert.equal(builds, 4)
  assert.deepEqual(JSON.parse(changed.stdout).results.map(r => r.version), ['2.1.7', '5.0.10'])
  await writeFile(join(dir, 'npm-shrinkwrap.json'), '{}')
  const invalid = capture()
  assert.equal(await main([dir, 'dep'], invalid.io, deps), 1)
  assert.equal(invalid.stdout, '')
})

test('separate paths processes reuse structured cache and recover from corrupt payloads', async (t) => {
  const dir = await fixture(t)
  const cache = await mkdtemp(join(tmpdir(), 'paths-cache-'))
  t.after(() => rm(cache, { recursive: true, force: true }))
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const bin = fileURLToPath(new URL('../bin/npm-dep-paths.js', import.meta.url))
  const run = args => spawnSync(process.execPath, [bin, dir, 'dep', ...args], { env: { ...process.env, XDG_CACHE_HOME: cache }, encoding: 'utf8' })
  const first = run(['--format', 'json'])
  assert.equal(first.status, 0, first.stderr)
  const cacheDir = join(cache, 'npm-dep-paths')
  const file = join(cacheDir, (await readdir(cacheDir))[0])
  const before = await readFile(file, 'utf8')
  const modifiedAt = (await stat(file, { bigint: true })).mtimeNs
  const second = run([])
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /parent-0000/)
  assert.equal((await stat(file, { bigint: true })).mtimeNs, modifiedAt)
  assert.equal(run(['--no-cache']).status, 0)
  assert.equal(await readFile(file, 'utf8'), before)
  const corrupt = JSON.parse(before)
  corrupt.value.results = []
  await writeFile(file, JSON.stringify(corrupt))
  const recovered = run(['--format', 'json'])
  assert.equal(recovered.status, 0, recovered.stderr)
  assert.deepEqual(JSON.parse(recovered.stdout), JSON.parse(first.stdout))
})

test('debug paths reports cache decisions on stderr while preserving JSON and Markdown', async (t) => {
  const dir = await fixture(t)
  const initial = capture()
  assert.equal(await main([dir, 'dep', '--format', 'json', '--debug'], initial.io), 0, initial.stderr)
  assert.match(initial.stderr, /cache miss/)
  const warm = capture()
  assert.equal(await main(['--debug', dir, 'dep', '--format', 'json'], warm.io), 0, warm.stderr)
  assert.deepEqual(JSON.parse(warm.stdout), JSON.parse(initial.stdout))
  assert.match(warm.stderr, /cache hit/)
  const fresh = capture()
  assert.equal(await main([dir, 'dep', '--debug', '--no-cache'], fresh.io), 0, fresh.stderr)
  assert.match(fresh.stdout, /^# npm-dep-paths/)
  assert.match(fresh.stderr, /cache bypass/)
  assert.doesNotMatch(fresh.stdout, /\[npm-dep-paths debug\]/)
})

async function isolatedCache(t) {
  const xdg = await mkdtemp(join(tempRoot, 'npm-dep-paths-xdg-'))
  const previous = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = xdg
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = previous
    await rm(xdg, { recursive: true, force: true })
  })
  return join(xdg, 'npm-dep-paths')
}

test('--clear-cache clears once before the project is loaded, then reports normally', async (t) => {
  await isolatedCache(t)
  const dir = await fixture(t)
  const events = []
  const deps = {
    clearCache: async (options) => {
      events.push(['clear', options.tool])
    },
    loadProject: async (path) => {
      events.push(['load'])
      return loadProject(path)
    },
  }
  const out = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json', '--clear-cache'], out.io, deps), 0)
  assert.deepEqual(events, [['clear', 'npm-dep-paths'], ['load']])
  assert.equal(JSON.parse(out.stdout).result.version, '5.0.9')
})

test('--clear-cache replaces a poisoned entry that --no-cache would leave in place', async (t) => {
  const cacheRoot = await isolatedCache(t)
  const dir = await fixture(t)
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json'], capture().io), 0)
  const [entryName] = await readdir(cacheRoot)
  const entryFile = join(cacheRoot, entryName)
  await writeFile(entryFile, 'poisoned')
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json', '--no-cache'], capture().io), 0)
  assert.equal(await readFile(entryFile, 'utf8'), 'poisoned')
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json', '--clear-cache'], capture().io), 0)
  assert.notEqual(await readFile(entryFile, 'utf8'), 'poisoned')
})

test('--clear-cache with --no-cache clears and writes nothing', async (t) => {
  const cacheRoot = await isolatedCache(t)
  const dir = await fixture(t)
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(join(cacheRoot, 'stale.json'), '{}')
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json', '--clear-cache', '--no-cache'], capture().io), 0)
  await assert.rejects(readdir(cacheRoot), { code: 'ENOENT' })
})

test('--clear-cache succeeds when no cache directory exists', async (t) => {
  await isolatedCache(t)
  const dir = await fixture(t)
  assert.equal(await main([dir, 'dep@5.0.9', '--format', 'json', '--clear-cache'], capture().io), 0)
})

test('--clear-cache does not delete anything for --help or --version', async (t) => {
  const cacheRoot = await isolatedCache(t)
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(join(cacheRoot, 'keep.json'), '{}')
  const help = capture()
  assert.equal(await main(['--clear-cache', '--help'], help.io), 0)
  assert.match(help.stdout, /^ {2}--clear-cache {2,}Delete this tool's cache before running$/m)
  assert.equal(await main(['--clear-cache', '--version'], capture().io), 0)
  assert.ok((await stat(join(cacheRoot, 'keep.json'))).isFile())
})

test('a cache that cannot be cleared exits 1 before the project is loaded', async (t) => {
  const dir = await fixture(t)
  let loaded = false
  const deps = {
    clearCache: async () => {
      throw new Error('EACCES: cannot clear')
    },
    loadProject: async (path) => {
      loaded = true
      return loadProject(path)
    },
  }
  const out = capture()
  assert.equal(await main([dir, 'dep@5.0.9', '--clear-cache'], out.io, deps), 1)
  assert.equal(out.stdout, '')
  assert.equal(out.stderr, 'npm-dep-paths: EACCES: cannot clear\n')
  assert.equal(loaded, false)
})
