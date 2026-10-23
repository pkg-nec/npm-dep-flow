import { spawn } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runProcess } from './process.js'

export async function readResolverRuntime(projectRoot, { env = process.env, run = runProcess } = {}) {
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.cmd', ''] : ['']) {
      const launcher = path.join(directory, `npm${suffix}`)
      try {
        await access(launcher)
      }
      catch { continue }
      const actual = await realpath(launcher)
      const source = await readFile(actual, 'utf8')
      const candidates = [path.dirname(path.dirname(actual)), path.join(path.dirname(actual), 'node_modules/npm')]
      for (const match of source.matchAll(/["']([^"'\r\n]*npm-cli\.js)["']/g)) candidates.push(path.dirname(path.dirname(match[1].replace(/%~dp0/gi, path.dirname(actual) + path.sep))))
      for (const npmPath of candidates) {
        let metadata
        try {
          metadata = JSON.parse(await readFile(path.join(npmPath, 'package.json'), 'utf8'))
        }
        catch { continue }
        if (metadata.name !== 'npm') continue
        const version = await run('npm', ['--version'], projectRoot, (command, args, options) => spawn(command, args, { ...options, env }))
        if (version.code || version.stdout.trim() !== metadata.version) throw new Error('Selected npm version/configuration mismatch for resolver')
        const require = createRequire(path.join(npmPath, 'package.json'))
        const resolverVersion = require('@npmcli/arborist/package.json').version
        return { npmPath, npmVersion: metadata.version, resolverVersion }
      }
      throw new Error('Cannot locate selected npm resolver libraries')
    }
  }
  throw new Error('Cannot locate npm resolver on PATH')
}
