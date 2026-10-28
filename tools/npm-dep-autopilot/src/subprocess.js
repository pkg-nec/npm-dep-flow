import { spawn } from 'node:child_process'

export function runProcess(commandName, args, options = {}) {
  const { cwd, signal, cmdShim = false, spawnImpl = spawn, platform = process.platform, debug } = options

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }

    const windowsShim = cmdShim && platform === 'win32'
    const command = windowsShim ? `${commandName}.cmd ${args.join(' ')}` : commandName
    const commandArgs = windowsShim ? [] : args
    const startedAt = Date.now()
    let child

    debug?.(`start pid=- ${commandName} ${args.join(' ')} cwd=${cwd ?? process.cwd()}`)
    try {
      child = spawnImpl(command, commandArgs, { cwd, shell: windowsShim, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const onAbort = () => finish(() => {
      child.kill?.()
      reject(signal.reason)
    })

    function finish(action) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      action()
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', error => finish(() => {
      child.kill?.()
      reject(error)
    }))
    child.on('close', code => finish(() => {
      debug?.(`end ${commandName} exit ${code} duration=${Date.now() - startedAt}ms`)
      resolve({ code, stdout, stderr })
    }))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
