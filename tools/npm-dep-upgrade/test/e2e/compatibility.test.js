import test from 'node:test'
import assert from 'node:assert/strict'
import { runCase } from './helpers/runner.js'

for (const caseId of ['D01', 'D01 tilde', 'T01', 'T02', 'T05', 'T06', 'T07', 'O01', 'O03', 'R01', 'R02', 'R05', 'F05', 'F06', 'H02', 'G03', 'S01']) test(`compat npm11.10.0 ${caseId}`, async (t) => {
  const npmCli = process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI
  assert.ok(npmCli, 'Provision npm11.10.0 and set NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI; requested compatibility cases cannot silently skip')
  const f = await runCase(caseId, { npmCli, t })
  assert.equal(f.npmVersion, '11.10.0')
})
for (const caseId of ['D01', 'T01', 'T05', 'F06']) test(`lockv2 ${caseId}`, async (t) => {
  await runCase(caseId, { lockfileVersion: 2, t })
})
for (const caseId of ['D01', 'T01', 'T07']) test(`cold ${caseId} no initial node_modules`, async (t) => {
  await runCase(caseId, { installed: false, t })
})
test('O03 npm12 direct-parent conflict controls and valid rule', async (t) => {
  await runCase('O03', { t })
})
