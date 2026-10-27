import assert from 'node:assert/strict'
import test from 'node:test'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readContext } from '../src/context.js'
import { scratch } from './helpers/commands.js'

const runner = config => async (command, args) => ({ code: 0, stdout: args[0] === '--version' ? '12.1.0' : JSON.stringify(config) })
test('context canonicalizes directories and hashes sorted effective configuration without storing secrets', async (t) => {
  const root = await scratch(t)
  const a = await readContext(root, runner({ registry: 'https://one.test', _auth: 'SECRET', before: 'moving' }))
  const b = await readContext(root, runner({ before: 'changed', _auth: 'SECRET', registry: 'https://one.test' }))
  assert.deepEqual(a, b)
  assert.doesNotMatch(JSON.stringify(a), /SECRET|one\.test/)
  assert.notEqual(a.configHash, (await readContext(root, runner({ 'registry': 'https://one.test', '@scope:registry': 'https://two.test', '_auth': 'SECRET' }))).configHash)
  assert.notEqual(a.configHash, (await readContext(root, runner({ registry: 'https://one.test', _auth: 'CHANGED' }))).configHash)
  const link = join(root, 'link')
  try {
    await symlink(root, link, 'dir')
  }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return
    throw error
  }
  assert.deepEqual(await readContext(link, runner({ registry: 'https://one.test', _auth: 'SECRET' })), a)
})
test('failed context discovery and malformed config never expose command output', async (t) => {
  const root = await scratch(t)
  for (const output of ['null', '[]', 'SECRET']) await assert.rejects(readContext(root, async (c, a) => ({ code: 0, stdout: a[0] === '--version' ? '12.1.0' : output })), e => !e.message.includes('SECRET'))
  await assert.rejects(readContext(root, async () => ({ code: 1, stdout: 'SECRET' })), /context/i)
})
