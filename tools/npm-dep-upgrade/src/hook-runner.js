// Internal Git hook boundary. Runs the user's normal hooks, then checks the
// exact staged tree before Git can consume any hook-created changes.
import { readFile } from 'node:fs/promises'
import { runProcess } from './process.js'
import { assertCommitState } from './git.js'
try {
  const [snapshot, hook, ...args] = process.argv.slice(2)
  const data = JSON.parse(await readFile(snapshot, 'utf8'))
  const result = await runProcess('git', ['-c', `core.hooksPath=${data.original}`, 'hook', 'run', '--ignore-missing', hook, '--', ...args], { cwd: data.guard.repoRoot, onStderr: s => process.stderr.write(s) })
  process.stdout.write(result.stdout)
  if (result.code) process.exitCode = result.code
  else if (hook !== 'post-commit') {
    data.guard.ownedFiles = Object.fromEntries(Object.entries(data.guard.ownedFiles).map(([name, value]) => [name, Buffer.from(value, 'base64')]))
    await assertCommitState(data.guard, data.paths, data.blobs)
    if (hook !== 'pre-commit') {
      const subject = (await readFile(args[0], 'utf8')).split(/\r?\n/)[0]
      if (subject !== data.subject) throw new Error('Hook changed required commit subject')
    }
  }
}
catch (error) {
  process.stderr.write(`npm-dep-upgrade: commit hook guard: ${error.message}\n`)
  process.exitCode = 1
}
