import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireLock } from '../src/lock.js'

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'autopilot-lock-'))

test('the first acquire holds the lock and records the pid', async () => {
  const dir = await tempDir()
  const lock = await acquireLock({ repo: '/repo', dir, pid: 4242, isAlive: () => true })
  const [file] = await readdir(dir)

  assert.ok(lock)
  assert.equal((await readFile(path.join(dir, file), 'utf8')).trim(), '4242')
})

test('a second acquire returns null while the first is alive', async () => {
  const dir = await tempDir()
  await acquireLock({ repo: '/repo', dir, pid: 1, isAlive: () => true })

  assert.equal(await acquireLock({ repo: '/repo', dir, pid: 2, isAlive: () => true }), null)
})

test('release lets a new instance acquire', async () => {
  const dir = await tempDir()
  const first = await acquireLock({ repo: '/repo', dir, pid: 1, isAlive: () => true })
  await first.release()

  assert.ok(await acquireLock({ repo: '/repo', dir, pid: 2, isAlive: () => true }))
})

test('a lock held by a dead pid is taken over', async () => {
  const dir = await tempDir()
  await acquireLock({ repo: '/repo', dir, pid: 1, isAlive: () => true })
  const lock = await acquireLock({ repo: '/repo', dir, pid: 2, isAlive: () => false })

  assert.ok(lock)
  const [file] = await readdir(dir)
  assert.equal((await readFile(path.join(dir, file), 'utf8')).trim(), '2')
})

test('garbage lock contents count as stale', async () => {
  const dir = await tempDir()
  const first = await acquireLock({ repo: '/repo', dir, pid: 1, isAlive: () => true })
  const [file] = await readdir(dir)
  await writeFile(path.join(dir, file), 'garbage')
  assert.ok(first)

  assert.ok(await acquireLock({ repo: '/repo', dir, pid: 2, isAlive: () => true }))
})

test('different repos do not conflict', async () => {
  const dir = await tempDir()
  await acquireLock({ repo: '/repo-a', dir, pid: 1, isAlive: () => true })

  assert.ok(await acquireLock({ repo: '/repo-b', dir, pid: 2, isAlive: () => true }))
})

test('release only removes the lock it owns', async () => {
  const dir = await tempDir()
  const first = await acquireLock({ repo: '/repo', dir, pid: 1, isAlive: () => true })
  await acquireLock({ repo: '/repo', dir, pid: 2, isAlive: () => false })
  await first.release()

  assert.equal((await readdir(dir)).length, 1)
})
