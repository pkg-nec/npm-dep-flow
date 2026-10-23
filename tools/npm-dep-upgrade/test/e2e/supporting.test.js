import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject } from './helpers/project.js'
import { supporting, direct, ago } from './fixtures/catalog.js'
import { plan, runUpgrade, assertSuccess, assertResolved } from './helpers/runner.js'
for (const multiple of [false, true]) test(`${multiple ? 'S02' : 'S01'} supporting helper major update`, async (t) => {
  const f = await createProject(supporting(multiple), {}, t), rows = await plan(f), row = rows.find(r => r.package === 'e2e-target' && r.resolution !== 'none')
  const output = await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']), undefined, { reproduce: true })
  assert.ok(output.actions[0].supportingChanges.some(c => c.package === 'e2e-helper' && c.newVersion === '3.0.2'))
  if (multiple) {
    await assertResolved(f, 'node_modules/e2e-parent-b', 'e2e-target', '6.0.9')
    await assertResolved(f, '', 'e2e-unrelated', '1.0.0')
  }
})
for (const variant of ['R01', 'R03 missing', 'R03 invalid', 'R04 A', 'R04 C']) test(`${variant} newest verifiable safe release`, async (t) => {
  const s = direct()
  let expected = '6.0.12'
  if (variant.startsWith('R03')) {
    s.packages['e2e-target']['6.0.12'].releasedAt = variant.endsWith('missing') ? undefined : 'invalid'
    expected = '6.0.10'
  }
  if (variant === 'R04 C') {
    s.advisories.push({ name: 'e2e-target', range: '>=6.0.10 <=6.0.12', id: 10002 })
    s.packages['e2e-target']['6.0.13'].releasedAt = ago(20)
    expected = '6.0.13'
  }
  const f = await createProject(s, {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']), expected)
})
