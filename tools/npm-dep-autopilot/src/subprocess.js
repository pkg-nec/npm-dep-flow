import { spawn } from 'node:child_process'
import { AutopilotError } from './errors.js'

const UNSAFE_WINDOWS_ARGUMENT = /[&"%|^<>\r\n]/

function quoteWindowsArgument(argument) {
  if (UNSAFE_WINDOWS_ARGUMENT.test(argument)) {
    throw new AutopilotError(`Argument is not safe to pass through a Windows shell: ${JSON.stringify(argument)}`, 'UNSAFE_ARGUMENT')
  }
  return argument === '' || /\s/.test(argument) ? `"${argument}"` : argument
}

export function runProcess(commandName, args, options = {}) {
  const {
    cwd,
    signal,
    cmdShim = false,
    spawnImpl = spawn,
    platform = process.platform,
    debug,
    killProcess = (pid, killSignal) => process.kill(pid, killSignal),
    killGraceMs = 5000,
  } = options

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const windows = platform === 'win32'
    const windowsShim = cmdShim && windows
    const startedAt = Date.now()
    let command = commandName
    let commandArgs = args

    if (windowsShim) {
      try {
        command = `${commandName}.cmd ${args.map(quoteWindowsArgument).join(' ')}`
      }
      catch (error) {
        reject(error)
        return
      }
      commandArgs = []
    }

    let child = null
    debug?.(`start pid=- ${commandName} ${args.join(' ')} cwd=${cwd ?? process.cwd()}`)
    try {
      child = spawnImpl(command, commandArgs, { cwd, shell: windowsShim, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let terminating = false
    const timers = []

    const finish = (action) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      action()
    }

    const send = (killSignal) => {
      if (windows) {
        const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        killer?.on?.('error', () => {})
        return
      }
      try {
        if (child.pid === undefined) throw new Error('no pid')
        killProcess(-child.pid, killSignal)
      }
      catch {
        child.kill?.(killSignal)
      }
    }

    function onAbort() {
      if (settled || terminating) return
      terminating = true
      send('SIGTERM')
      const escalation = setTimeout(() => {
        send('SIGKILL')
        const giveUp = setTimeout(() => finish(() => reject(signal.reason)), killGraceMs)
        giveUp.unref?.()
        timers.push(giveUp)
      }, killGraceMs)
      escalation.unref?.()
      timers.push(escalation)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', error => finish(() => reject(error)))
    child.on('close', code => finish(() => {
      if (terminating) {
        reject(signal.reason)
        return
      }
      debug?.(`end ${commandName} exit ${code} duration=${Date.now() - startedAt}ms`)
      resolve({ code, stdout, stderr })
    }))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
