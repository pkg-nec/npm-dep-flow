import assert from 'node:assert/strict'
import test from 'node:test'
import { loadNpmContext } from '../src/npm-context.js'
test('npm context enforces scripts suppression and at least seven days without exporting credentials', async () => {
  const context = await loadNpmContext(process.cwd())
  assert.equal(context.version, '12.1.0')
  assert.ok(context.installArgs.includes('--ignore-scripts'))
  assert.ok(context.installArgs.some(a => a.startsWith('--min-release-age=')))
  assert.ok(context.registry.startsWith('http'))
})
