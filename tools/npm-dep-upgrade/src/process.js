import { debugSpawn } from './debug.js'
import crossSpawn from 'cross-spawn'

export function runProcess(command, args, { cwd, env = process.env, spawnImpl = crossSpawn, onStderr, shell = false, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = debugSpawn(spawnImpl, command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell, windowsHide: true })
    }
    catch (error) {
      reject(error)
      return
    }
    let stdout = '', stderr = '', count = 0, done = false
    const rejectOnce = (error) => {
      if (!done) {
        done = true
        child.kill()
        reject(error)
      }
    }
    for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        count += Buffer.byteLength(chunk)
        if (count > maxBytes) return rejectOnce(new Error('Subprocess output exceeded limit'))
        if (label === 'stdout') stdout += chunk
        else {
          stderr += chunk
          onStderr?.(chunk)
        }
      })
    }
    child.on('error', rejectOnce)
    child.on('close', (code, signal) => {
      if (done) return
      done = true
      if (signal || code === null) reject(new Error(`Subprocess terminated: ${signal || 'unknown status'}`))
      else resolve({ code, stdout, stderr })
    })
  })
}
