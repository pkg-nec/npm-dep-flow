import assert from 'node:assert/strict'
import test from 'node:test'

test('formatter supports strategy descriptions, optional scope and literal placeholders', async () => {
  const { formatCommitMessage } = await import('../src/commit-message.js')
  const identity = { package: 'joi', oldVersion: '18.2.8', newVersion: '18.2.9', strategy: 'update-within-declared-range', description: 'bump joi from 18.2.8 to 18.2.9' }
  assert.equal(formatCommitMessage(identity), 'deps: bump joi from 18.2.8 to 18.2.9')
  assert.equal(formatCommitMessage(identity, { module: 'webapp' }), 'deps(webapp): bump joi from 18.2.8 to 18.2.9')
  assert.equal(formatCommitMessage({ ...identity, description: 'migrate Angular toolchain from 21.2.25 to 21.2.26' }, { module: 'webapp' }), 'deps(webapp): migrate Angular toolchain from 21.2.25 to 21.2.26')
  assert.equal(formatCommitMessage(identity, { module: 'api', commitMessageTemplate: 'upgrade({module}): {package} {oldVersion} -> {newVersion} [{strategy}]' }), 'upgrade(api): joi 18.2.8 -> 18.2.9 [update-within-declared-range]')
  assert.equal(formatCommitMessage(identity, { module: '$&' }), 'deps($&): bump joi from 18.2.8 to 18.2.9')
})
