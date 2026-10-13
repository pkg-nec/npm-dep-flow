import { spawn } from 'node:child_process'

export function runProcess(commandName, args, cwd, spawnImpl = spawn, platform = process.platform) {
  return new Promise((resolve, reject) => {
    const windows = platform === 'win32'
    const command = windows ? `${commandName}.cmd ${args.join(' ')}` : commandName
    const commandArgs = windows ? [] : args
    let child

    try {
      child = spawnImpl(command, commandArgs, {
        cwd,
        shell: windows,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const fail = error => {
      if (settled) return
      settled = true
      child.kill?.()
      reject(error)
    }

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', fail)
    child.on('close', code => {
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr })
    })
  })
}
