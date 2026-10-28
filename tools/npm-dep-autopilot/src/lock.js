import { createHash } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return error.code === 'EPERM'
  }
}

async function tryCreate(file, pid) {
  try {
    const handle = await open(file, 'wx')
    await handle.writeFile(`${pid}\n`)
    await handle.close()
    return true
  }
  catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

async function readOwner(file) {
  try {
    const pid = Number.parseInt(await readFile(file, 'utf8'), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }
  catch {
    return null
  }
}

export async function acquireLock({ repo, dir = process.env.XDG_RUNTIME_DIR || os.tmpdir(), pid = process.pid, isAlive = processAlive }) {
  const name = `npm-dep-autopilot-${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.lock`
  const file = path.join(dir, name)
  const release = async () => {
    if (await readOwner(file) === pid) await unlink(file).catch(() => {})
  }

  if (await tryCreate(file, pid)) return { release }

  const owner = await readOwner(file)
  if (owner !== null && isAlive(owner)) return null

  await unlink(file).catch(() => {})
  return await tryCreate(file, pid) ? { release } : null
}
