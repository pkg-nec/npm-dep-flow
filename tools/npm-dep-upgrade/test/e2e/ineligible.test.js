import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject } from './helpers/project.js'
import { direct, transitive, separate, existingOverride } from './fixtures/catalog.js'
import { plan, runUpgrade, assertUnchanged } from './helpers/runner.js'

for (const kind of ['D03', 'D04 exact', 'T07 pinned', 'T08', 'O02', 'F04 clean']) test(`${kind} refuses unsupported or absent target`, async (t) => {
  let s = direct()
  if (kind === 'D03') s.manifest.dependencies['e2e-target'] = '6.0.9'
  if (kind === 'D04 exact') {
    s = direct('devDependencies')
    s.manifest.peerDependencies = { 'e2e-target': '6.0.9' }
  }
  if (kind === 'T07 pinned') s = separate()
  if (kind === 'T08') {
    s = transitive()
    s.packages['e2e-parent-a']['1.2.4'].manifest.dependencies['e2e-target'] = '6.0.9'
    // No parent release exists to clear the pin, so neither strategy can remediate it (parent upgrades have their own cases).
    delete s.packages['e2e-parent-a']['1.3.0']
  }
  if (kind === 'O02') s = existingOverride(true)
  if (kind === 'F04 clean') s.advisories = []
  const f = await createProject(s, {}, t), rows = await plan(f), row = rows.find(r => r.resolution === 'none') || rows[0]
  await assertUnchanged(f, await runUpgrade(f, [row?.id || 'abcdef0']), /ineligible|unsupported|conflict|excludes|candidate|not found|no planner/i)
  assert.equal(f.registry.calls.filter(c => c.path.startsWith('/tarballs/') && c.phase !== 'seed').length, 0)
})
test('H05 invalid selectors, options, package filter and unknown ID', async (t) => {
  const f = await createProject(direct(), {}, t), [row] = await plan(f)
  for (const args of [[], ['abc'], ['a'.repeat(65)], ['ghijklm'], ['.', row.id, row.id], ['--unknown'], [row.id, '--package', 'missing-package'], ['0'.repeat(64)]]) await assertUnchanged(f, await runUpgrade(f, args), /argument|selector|unknown|not found|no planner|usage|multiple/i)
})
