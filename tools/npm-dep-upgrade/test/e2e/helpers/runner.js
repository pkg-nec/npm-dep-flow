import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { command, checked } from './commands.js'
export async function plan(f, format = 'json') {
  const output = await checked(f, 'npm-dep-upgrade-plan', ['.', '--format', format])
  return format === 'json' ? JSON.parse(output).rows : output
}
export const runUpgrade = (f, args) => command(f, 'npm-dep-upgrade', args)
export async function assertResolved(f, parentLocation, name, version, root = f.root) {
  const require = createRequire(path.join(root, parentLocation, '__resolve.cjs'))
  const manifest = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'))
  assert.equal(manifest.name, name)
  assert.equal(manifest.version, version)
}
export async function assertUnchanged(f, result, pattern) {
  assert.equal(result.code, 1, result.stdout)
  assert.equal(result.stdout, '')
  if (pattern) assert.match(result.stderr, pattern)
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), f.initialHead)
  for (const [name, bytes] of Object.entries(f.initialFiles)) assert.deepEqual(await readFile(path.join(f.root, name)), bytes, `${name} changed`)
  assert.equal(await checked(f, 'git', ['diff', '--cached', '--name-only']), '')
}
async function noScripts(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.notEqual(entry.name, 'SCRIPT_RAN')
    if (entry.isDirectory() && entry.name !== '.git') await noScripts(path.join(root, entry.name))
  }
}
export async function assertSuccess(f, result, version = '6.0.12', { reproduce = false, location, name } = {}) {
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  name ??= output.package
  location ??= output.actions[0].targetLocations[0]
  assert.equal(output.package, name)
  assert.equal(output.actions[0].targetVersion, version)
  assert.ok(output.actions[0].targetLocations.includes(location))
  assert.equal(await checked(f, 'git', ['rev-list', '--count', `${f.initialHead}..HEAD`]), '1')
  assert.equal(await checked(f, 'git', ['log', '-1', '--format=%s']), `deps: bump ${name} from 6.0.9 to ${version}`)
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), output.commits[0].hash)
  const files = (await checked(f, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n').map(p => p.replace(/^nested app\//, ''))
  assert.deepEqual(files.sort(), [...output.commits[0].changedFiles].map(p => p.replace(/^nested app\//, '')).sort())
  assert.ok(files.every(p => ['package.json', 'package-lock.json'].includes(p)))
  for (const file of files) assert.equal(await checked(f, 'git', ['show', `HEAD:${f.root === f.repoRoot ? '' : 'nested app/'}${file}`]), (await readFile(path.join(f.root, file), 'utf8')).trim())
  await assertResolved(f, path.posix.dirname(location).replace(/(?:^|\/)node_modules$/, ''), name, version)
  await noScripts(f.root)
  if (reproduce) {
    const copy = path.join(f.scratch, 'clean ci')
    await mkdir(copy)
    for (const file of ['package.json', 'package-lock.json', '.npmrc']) await writeFile(path.join(copy, file), await readFile(path.join(f.root, file)))
    await checked(f, 'npm', ['ci', '--ignore-scripts', '--no-audit'], copy)
    await assertResolved(f, path.posix.dirname(location).replace(/(?:^|\/)node_modules$/, ''), name, version, copy)
    await noScripts(copy)
  }
  return output
}
export async function runCase(caseId, { npmCli, lockfileVersion = 3, installed = true, t } = {}) {
  const { createProject } = await import('./project.js')
  const { direct, transitive, ancestor, shared, separate, existingOverride, supporting, ago } = await import('../fixtures/catalog.js')
  const { installCheckpoints } = await import('./commands.js')
  const directCases = ['D01', 'R01', 'R02', 'R05', 'F05', 'F06', 'G03']
  const scenarioByCase = { T02: ancestor, T05: shared, T06: () => shared(true), T07: separate, O01: existingOverride, S01: supporting }
  let s
  if (caseId === 'D01 tilde') s = direct('dependencies', '~')
  else if (directCases.includes(caseId)) s = direct()
  else s = (scenarioByCase[caseId] ?? transitive)()
  if (caseId === 'R02') for (const v of ['6.0.10', '6.0.12']) s.packages['e2e-target'][v].releasedAt = ago(1)
  const f = await createProject(s, { npmCli, lockfileVersion, installed }, t), rows = await plan(f), row = rows.find(r => r.package === 'e2e-target' && r.resolution !== 'none') || rows[0]
  if (caseId === 'O03') {
    for (const rule of [{ 'e2e-target': '^6.0.12' }, { '.': '1.2.4', 'e2e-target': '^6.0.12' }]) {
      const m = { ...s.manifest, overrides: { 'e2e-parent-a@1.2.4': rule } }
      await writeFile(path.join(f.root, 'package.json'), JSON.stringify(m))
      const control = await command(f, 'npm', ['install', '--ignore-scripts', '--no-audit'])
      assert.equal(control.code, 1)
      assert.match(control.stderr, /EOVERRIDE/)
      await writeFile(path.join(f.root, 'package.json'), f.initialFiles['package.json'])
    }
  }
  if (caseId === 'R05') {
    const original = s.advisories
    s.advisories = phase => phase === 'stale' ? [...original, { name: 'e2e-target', range: '6.0.12', id: 10002 }] : original
    s.checkpoint = ({ count, stage }) => {
      if (count === 1 && stage === 'after') {
        f.registry.setPhase('stale')
        s.packages['e2e-target']['6.0.13'].releasedAt = ago(20)
      }
    }
    await installCheckpoints(f)
  }
  const result = await runUpgrade(f, [caseId === 'H02' ? row.id.slice(0, 7) : row.id, '--format', 'json'])
  if (['R02', 'R05'].includes(caseId)) {
    await assertUnchanged(f, result, caseId === 'R05' ? /stale/i : /candidate|ineligible/i)
    return f
  }
  await assertSuccess(f, result, '6.0.12', { reproduce: true })
  if (caseId === 'T07') await assertResolved(f, 'node_modules/e2e-parent-b', 'e2e-target', '6.0.9')
  if (lockfileVersion === 2) {
    const lock = JSON.parse(await readFile(path.join(f.root, 'package-lock.json')))
    assert.equal(lock.lockfileVersion, 2)
    assert.ok(lock.dependencies)
    const targetNode = lock.packages[row.targetLocation]
    assert.equal(targetNode.version, '6.0.12')
  }
  if (caseId === 'F05') {
    const head = await checked(f, 'git', ['rev-parse', 'HEAD'])
    const repeat = await runUpgrade(f, [row.id])
    assert.equal(repeat.code, 1)
    assert.match(repeat.stderr, /not found|no planner/i)
    assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD']), head)
  }
  return f
}
