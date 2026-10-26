import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveCutoff, readReleasePolicy } from '../src/policy.js'

const run = config => async (command, args) => {
  assert.equal(command, 'npm')
  assert.deepEqual(args, ['config', 'list', '--json'])
  return { code: 0, stdout: JSON.stringify(config), stderr: '' }
}
const day = 86400000

test('the release-age policy comes from npm config, with seven days as the floor', async () => {
  assert.deepEqual(await readReleasePolicy('/project', run({})), { minAgeDays: 7, cutoffMs: null })
  assert.deepEqual(await readReleasePolicy('/project', run({ 'min-release-age': 30 })), { minAgeDays: 30, cutoffMs: null })
  assert.deepEqual(await readReleasePolicy('/project', run({ 'min-release-age': '14' })), { minAgeDays: 14, cutoffMs: null })
  assert.deepEqual(await readReleasePolicy('/project', run({ 'min-release-age': 2 })), { minAgeDays: 7, cutoffMs: null })
  assert.deepEqual(await readReleasePolicy('/project', run({ before: '2026-09-01T00:00:00.000Z' })), { minAgeDays: 7, cutoffMs: Date.parse('2026-09-01T00:00:00.000Z') })
})

test('an invalid policy or a failing npm is an error, never a silent default', async () => {
  for (const config of [{ 'min-release-age': 'soon' }, { 'min-release-age': -1 }, { before: 'not a date' }]) await assert.rejects(readReleasePolicy('/project', run(config)), /release-age policy/i)
  await assert.rejects(readReleasePolicy('/project', async () => ({ code: 1, stdout: '', stderr: 'boom' })), /release-age policy/i)
  await assert.rejects(readReleasePolicy('/project', async () => ({ code: 0, stdout: 'nope', stderr: '' })), /release-age policy/i)
})

test('the effective cutoff is the earlier of the age floor and an explicit before date', () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z')
  assert.equal(effectiveCutoff({ minAgeDays: 7, cutoffMs: null }, now), now - 7 * day)
  assert.equal(effectiveCutoff({ minAgeDays: 7, cutoffMs: now - 30 * day }, now), now - 30 * day)
  assert.equal(effectiveCutoff({ minAgeDays: 30, cutoffMs: now - 10 * day }, now), now - 30 * day)
})
