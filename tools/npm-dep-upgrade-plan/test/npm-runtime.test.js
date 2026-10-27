import assert from 'node:assert/strict'
import test from 'node:test'
import { readResolverRuntime } from '../src/npm-runtime.js'

test('refuses a launcher whose version differs from its npm package', async () => {
  await assert.rejects(readResolverRuntime(process.cwd(), { run: async () => ({ code: 0, stdout: '0.0.0' }) }), /version\/configuration mismatch/)
})
test('reports unavailable npm without accepting another tool as a resolver', async () => {
  await assert.rejects(readResolverRuntime(process.cwd(), { env: { PATH: '/nonexistent' } }), /Cannot locate npm resolver/)
})
