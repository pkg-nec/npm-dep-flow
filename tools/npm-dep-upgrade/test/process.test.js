import assert from 'node:assert/strict'
import test from 'node:test'
import { runProcess } from '../src/process.js'

test('process runner preserves argument boundaries and collects result', async () => {
  const r = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write("progress")', 'spaces & symbols'], { cwd: process.cwd() })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, 'spaces & symbols')
  assert.equal(r.stderr, 'progress')
})
test('process runner bounds output and reports spawn failures', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2000))'], { cwd: process.cwd(), maxBytes: 100 }), /output.*limit/i)
  await assert.rejects(runProcess('e2e-no-such-command', [], { cwd: process.cwd() }), /ENOENT|not found|spawn/i)
})
