import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '../../src/process.js'

export async function git(root, args) {
  const r = await runProcess('git', args, { cwd: root })
  if (r.code) throw new Error(r.stderr || `git exited ${r.code}`)
  return r.stdout
}
export async function gitProject(t, { nested = false } = {}) {
  const base = process.env.NPM_DEP_FLOW_TEST_TMPDIR || path.join(tmpdir(), 'npm-dep-upgrade-unit')
  await mkdir(base, { recursive: true })
  const repo = await mkdtemp(path.join(base, 'git-project-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await git(repo, ['init', '-b', 'fixture'])
  await git(repo, ['config', 'user.name', 'Fixture'])
  await git(repo, ['config', 'user.email', 'fixture@example.test'])
  await mkdir(path.join(repo, 'empty-hooks'))
  await git(repo, ['config', 'core.hooksPath', path.join(repo, 'empty-hooks')])
  const root = nested ? path.join(repo, 'project with spaces & symbols') : repo
  await mkdir(root, { recursive: true })
  const manifest = { name: 'e2e-app', version: '1.0.0', dependencies: { 'e2e-target': '^6.0.8' } }
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': manifest, 'node_modules/e2e-target': { version: '6.0.9' } } }
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
  await writeFile(path.join(repo, 'unrelated.txt'), 'original\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'test: seed project'])
  return { root, repo, manifest, lock }
}
