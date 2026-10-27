import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createProject } from './helpers/project.js'
import { direct, transitive } from './fixtures/catalog.js'
import { plan, assertSuccess } from './helpers/runner.js'
import { command, checked } from './helpers/commands.js'

for (const relative of [false, true]) for (const trans of [false, true]) test(`project argument ${relative ? 'relative' : 'absolute'} ${trans ? 'transitive' : 'direct'} upgrades only the target repository`, async (t) => {
  const f = await createProject(trans ? transitive() : direct(), { nested: true }, t), [row] = await plan(f)
  const caller = path.join(f.scratch, 'caller project & dollar $')
  await mkdir(caller)
  await checked(f, 'git', ['init', '-b', 'caller'], caller)
  await checked(f, 'git', ['config', 'user.name', 'Fixture'], caller)
  await checked(f, 'git', ['config', 'user.email', 'fixture@example.invalid'], caller)
  await checked(f, 'git', ['config', 'core.hooksPath', path.join(f.scratch, 'hooks')], caller)
  for (const name of ['package.json', 'package-lock.json', 'unrelated.txt']) await writeFile(path.join(caller, name), 'initial caller file\n')
  await checked(f, 'git', ['add', '.'], caller)
  await checked(f, 'git', ['commit', '-m', 'test: seed caller repository'], caller)
  for (const name of ['package.json', 'package-lock.json', 'unrelated.txt']) await writeFile(path.join(caller, name), 'preserve caller edits\n')
  await checked(f, 'git', ['add', 'unrelated.txt'], caller)
  const callerHead = await checked(f, 'git', ['rev-parse', 'HEAD'], caller), callerIndex = await checked(f, 'git', ['diff', '--cached', '--binary'], caller)
  const project = relative ? path.relative(caller, f.root) : f.root
  const result = await command(f, 'npm-dep-upgrade', ['--format', 'json', project, row.id, '--package', row.package], caller)
  await assertSuccess(f, result, '6.0.12', { reproduce: true })
  for (const name of ['package.json', 'package-lock.json', 'unrelated.txt']) assert.equal(await readFile(path.join(caller, name), 'utf8'), 'preserve caller edits\n')
  assert.equal(await checked(f, 'git', ['rev-parse', 'HEAD'], caller), callerHead)
  assert.equal(await checked(f, 'git', ['diff', '--cached', '--binary'], caller), callerIndex)
})
