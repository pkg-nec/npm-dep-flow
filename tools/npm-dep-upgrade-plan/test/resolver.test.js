import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveChoices } from '../src/resolver.js'
test('rejects malformed worker evidence rather than claiming coverage', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'resolver-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all(['package.json', 'package-lock.json'].map(n => writeFile(path.join(root, n), '{}')))
  const options = { readRuntime: async () => ({ npmPath: root }), run: async () => ({ code: 0, stdout: '{}' }) }
  await assert.rejects(resolveChoices({ root }, {}, [], options), /Invalid resolver evidence/)
  options.run = async () => ({ code: 1, stdout: '', stderr: 'credential-sensitive text' })
  await assert.rejects(resolveChoices({ root }, {}, [], options), error => error.message === 'Dependency resolver failed')
})
