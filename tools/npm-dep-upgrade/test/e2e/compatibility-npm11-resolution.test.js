import test from 'node:test'
import assert from 'node:assert/strict'
import { runCase } from './helpers/runner.js'
for (const caseId of ['D01', 'D01 tilde', 'T01', 'T02', 'T05', 'T07']) test(`compat npm11.10.0 ${caseId}`, async (t) => {
  const npmCli = process.env.NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI
  assert.ok(npmCli, 'Provision npm11.10.0 and set NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI; requested compatibility cases cannot silently skip')
  const f = await runCase(caseId, { npmCli, t })
  assert.equal(f.npmVersion, '11.10.0')
})
