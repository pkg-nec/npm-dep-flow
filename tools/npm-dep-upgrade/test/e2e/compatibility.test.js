import test from 'node:test'
import { runCase } from './helpers/runner.js'
for (const caseId of ['D01', 'T01', 'T05', 'F06']) test(`lockv2 ${caseId}`, async (t) => {
  await runCase(caseId, { lockfileVersion: 2, t })
})
for (const caseId of ['D01', 'T01', 'T07']) test(`cold ${caseId} no initial node_modules`, async (t) => {
  await runCase(caseId, { installed: false, t })
})
test('O03 npm12 direct-parent conflict controls and valid rule', async (t) => {
  await runCase('O03', { t })
})
