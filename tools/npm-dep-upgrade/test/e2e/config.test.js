import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { createProject } from './helpers/project.js'
import { direct } from './fixtures/catalog.js'
import { plan, assertResolved } from './helpers/runner.js'
import { command, checked } from './helpers/commands.js'

test('explicit JSON configuration selects nested project through real sibling tools and bypasses user commit hooks', async (t) => {
  const f = await createProject(direct(), { nested: true }, t), [row] = await plan(f)
  for (const name of ['pre-commit', 'commit-msg']) await writeFile(path.join(f.scratch, 'hooks', name), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
  const config = path.join(f.scratch, 'upgrade.json')
  await writeFile(config, JSON.stringify({ project: path.relative(f.scratch, f.root), module: 'webapp', format: 'json', debug: true, commitMessageTemplate: 'deps({module}): {description}', gitCommitArgs: ['--no-verify'] }))
  const result = await command(f, 'npm-dep-upgrade', [row.id, '--config', config], f.scratch)
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.commits[0].subject, 'deps(webapp): bump e2e-target from 6.0.9 to 6.0.12')
  assert.equal(await checked(f, 'git', ['log', '-1', '--format=%s']), report.commits[0].subject)
  assert.equal(await checked(f, 'git', ['rev-list', '--count', `${f.initialHead}..HEAD`]), '1')
  assert.match(result.stderr, /\[npm-dep-upgrade-plan debug\]/)
  assert.match(result.stderr, /\[npm-dep-audit debug\]/)
  assert.match(result.stderr, /\[npm-dep-paths debug\]/)
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'package.json'))).dependencies['e2e-target'], '^6.0.12')
  await assertResolved(f, '', 'e2e-target', '6.0.12')
  assert.equal(await checked(f, 'git', ['diff', '--cached', '--name-only']), '')
})
