import test from 'node:test'
import { createProject } from './helpers/project.js'
import { direct, supporting, ago } from './fixtures/catalog.js'
import { plan, runUpgrade, assertUnchanged, assertSuccess } from './helpers/runner.js'
import { installCheckpoints } from './helpers/commands.js'

for (const variant of ['R02', 'R03 missing all', 'R03 invalid all', 'R04 B', 'candidate-only advisory', 'S03']) test(`${variant} security and release-age rejection`, async (t) => {
  const s = variant === 'S03' ? supporting() : direct()
  if (variant === 'R02') for (const v of ['6.0.10', '6.0.12']) s.packages['e2e-target'][v].releasedAt = ago(1)
  if (variant.startsWith('R03')) for (const v of ['6.0.10', '6.0.12']) s.packages['e2e-target'][v].releasedAt = variant.includes('missing') ? undefined : 'bad-time'
  if (['R04 B', 'candidate-only advisory'].includes(variant)) s.advisories.push({ name: 'e2e-target', range: '>=6.0.10 <=6.0.12', id: 10002 })
  if (variant === 'S03') s.advisories.push({ name: 'e2e-helper', range: '3.0.2', id: 10003 })
  const f = await createProject(s, {}, t), rows = await plan(f)
  await assertUnchanged(f, await runUpgrade(f, [rows.find(r => r.package === 'e2e-target').id]), /candidate|safe|old.enough|supporting|vulnerab|ineligible/i)
})
test('candidate-only advisory excludes newest safe-looking release before install', async (t) => {
  const s = direct()
  s.advisories.push({ name: 'e2e-target', range: '6.0.12', id: 10002 })
  const f = await createProject(s, {}, t), [row] = await plan(f)
  await assertSuccess(f, await runUpgrade(f, [row.id, '--format', 'json']), '6.0.10')
})
test('R05 G05 stale recommendation at explicit install checkpoint', async (t) => {
  const s = direct(), original = s.advisories
  s.advisories = phase => phase === 'stale' ? [...original, { name: 'e2e-target', range: '6.0.12', id: 10002 }] : original
  const f = await createProject(s, {}, t), [row] = await plan(f)
  s.checkpoint = ({ stage, count }) => {
    if (stage === 'after' && count === 1) {
      f.registry.setPhase('stale')
      s.packages['e2e-target']['6.0.13'].releasedAt = ago(20)
    }
  }
  await installCheckpoints(f)
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /stale/i)
})
for (const variant of ['metadata', 'candidate service', 'candidate malformed']) test(`F01 ${variant} failure is not an empty advisory result`, async (t) => {
  const s = direct(), f = await createProject(s, {}, t), [row] = await plan(f)
  s.request = ({ call }) => {
    if (variant === 'metadata' && call.path === '/e2e-target') return { status: 503 }
    if (variant.startsWith('candidate') && call.body?.['e2e-target']?.includes('6.0.12')) return variant.endsWith('malformed') ? { status: 200, body: { 'e2e-target': 'invalid' } } : { status: 503 }
  }
  await assertUnchanged(f, await runUpgrade(f, [row.id]), /registry|security|advisory|planner|view/i)
})
