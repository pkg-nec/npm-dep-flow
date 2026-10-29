import { DeadlineReached } from './errors.js'

export function computeDeadline(now, hhmm) {
  const [hour, minute] = hhmm.split(':').map(Number)
  const deadline = new Date(now)
  deadline.setHours(hour, minute, 0, 0)
  if (deadline <= now) deadline.setDate(deadline.getDate() + 1)
  return deadline
}

export function createDeadline({ deadlineAt, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const controller = new AbortController()
  const timers = new Set()
  let expired = false

  const expire = () => {
    if (expired) return
    expired = true
    controller.abort(new DeadlineReached())
  }

  const remaining = deadlineAt.getTime() - now()
  if (remaining <= 0) expire()
  else timers.add(setTimer(expire, remaining))
  for (const timer of timers) timer.unref?.()

  const sleep = ms => new Promise((resolve, reject) => {
    if (expired) {
      reject(new DeadlineReached())
      return
    }

    let timer = null
    const onAbort = () => {
      timers.delete(timer)
      clearTimer(timer)
      reject(new DeadlineReached())
    }

    timer = setTimer(() => {
      timers.delete(timer)
      controller.signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timers.add(timer)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  const dispose = () => {
    for (const timer of timers) clearTimer(timer)
    timers.clear()
  }

  return { signal: controller.signal, expired: () => expired, sleep, dispose }
}
