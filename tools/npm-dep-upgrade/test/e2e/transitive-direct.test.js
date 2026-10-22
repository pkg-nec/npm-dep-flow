import test from 'node:test'
import { transitive } from './fixtures/catalog.js'
import { applyTransitive as apply, assertResolved } from './helpers/runner.js'
for (const field of ['dependencies']) for (const op of ['^', '~']) test(`T01 ${field} child ${op}`, async (t) => {
  const f = await apply(t, transitive(field, op))
  await assertResolved(f, '', 'e2e-parent-a', '1.2.4')
})
