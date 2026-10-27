import assert from 'node:assert/strict'
import test from 'node:test'
import { installProject } from '../src/installer.js'

test('installer enforces context policy and rejects a failed npm command', async () => {
  const context = { installArgs: ['install', '--ignore-scripts', '--min-release-age=7'] }
  const run = async (command, args, options) => {
    assert.equal(command, 'npm')
    assert.deepEqual(args, context.installArgs)
    assert.equal(options.cwd, '/fixture')
    return { code: 1, stdout: '', stderr: 'failure' }
  }
  await assert.rejects(installProject('/fixture', context, { run }), /install/i)
})
