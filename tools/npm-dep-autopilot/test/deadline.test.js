import assert from 'node:assert/strict'
import test from 'node:test'
import { computeDeadline, createDeadline } from '../src/deadline.js'
import { DeadlineReached } from '../src/errors.js'

function fakeClock() {
  let time = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { at: time + ms, fn })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = time + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        time = due[1].at
        due[1].fn()
      }
      time = target
    },
    pending: () => timers.size,
  }
}

test('computeDeadline returns the same day when the time is still ahead', () => {
  assert.deepEqual(computeDeadline(new Date(2026, 9, 28, 22, 0), '23:00'), new Date(2026, 9, 28, 23, 0))
})

test('computeDeadline returns midnight of the next day', () => {
  assert.deepEqual(computeDeadline(new Date(2026, 9, 28, 10, 0), '00:00'), new Date(2026, 9, 29, 0, 0))
})

test('computeDeadline moves to the next day at exactly the deadline', () => {
  assert.deepEqual(computeDeadline(new Date(2026, 9, 29, 0, 0), '00:00'), new Date(2026, 9, 30, 0, 0))
})

test('sleep resolves when its timer fires before the deadline', async () => {
  const clock = fakeClock()
  const deadline = createDeadline({ deadlineAt: new Date(10_000), ...clock })
  const slept = deadline.sleep(1000)
  clock.advance(1000)
  await slept
  assert.equal(deadline.expired(), false)
  assert.equal(deadline.signal.aborted, false)
})

test('the deadline rejects a pending sleep and aborts the signal', async () => {
  const clock = fakeClock()
  const deadline = createDeadline({ deadlineAt: new Date(500), ...clock })
  const slept = deadline.sleep(1000)
  clock.advance(500)
  await assert.rejects(slept, DeadlineReached)
  assert.equal(deadline.expired(), true)
  assert.ok(deadline.signal.reason instanceof DeadlineReached)
})

test('sleep after expiry rejects immediately', async () => {
  const clock = fakeClock()
  const deadline = createDeadline({ deadlineAt: new Date(0), ...clock })
  await assert.rejects(deadline.sleep(10), DeadlineReached)
})

test('dispose clears timers', () => {
  const clock = fakeClock()
  const deadline = createDeadline({ deadlineAt: new Date(5000), ...clock })
  deadline.sleep(100).catch(() => {})
  deadline.dispose()
  assert.equal(clock.pending(), 0)
})
