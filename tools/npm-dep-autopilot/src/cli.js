import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { computeDeadline, createDeadline } from './deadline.js'
import { runDebug } from './debug.js'
import { AutopilotError } from './errors.js'
import { createGh } from './gh.js'
import { createGit } from './git.js'
import { acquireLock } from './lock.js'
import { runAutopilot } from './runner.js'
import { runProcess } from './subprocess.js'
import { createTools } from './tools.js'

const toolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const helpBody = `Usage: npm-dep-autopilot --config <path> [options]

Keeps npm dependencies patched: plans and applies vulnerability fixes with the
npm-dep tools, then pushes branches and opens pull requests through gh.

Options:
  --config <path>  JSON configuration file (required)
  --debug          Log external actions to stderr, including planner and upgrade
  --no-debug       Disable debug logging, overriding NPM_DEP_FLOW_DEBUG
  --version        Show version and tool directory
  --help           Show this help
`

function parseArgs(argv) {
  const args = { config: null, debug: undefined }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      index += 1
      if (index >= argv.length) throw new AutopilotError('--config needs a path', 'USAGE')
      args.config = argv[index]
    }
    else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length)
    else if (arg === '--debug' || arg === '--no-debug') {
      if (args.debug !== undefined) throw new AutopilotError('Repeated debug option', 'USAGE')
      args.debug = arg === '--debug'
    }
    else throw new AutopilotError(`Unknown argument: ${arg}`, 'USAGE')
  }

  return args
}

async function toolVersion() {
  const manifest = JSON.parse(await readFile(path.join(toolDir, 'package.json'), 'utf8'))
  return manifest.version
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, now = () => new Date() } = {}) {
  let lock = null
  let deadline = null

  try {
    if (argv.includes('--help')) {
      stdout.write(`npm-dep-autopilot v${await toolVersion()}\n\n${helpBody}`)
      return 0
    }
    if (argv.includes('--version')) {
      stdout.write(`npm-dep-autopilot v${await toolVersion()}\nLocation: ${toolDir}\n`)
      return 0
    }
    const args = parseArgs(argv)
    if (!args.config) throw new AutopilotError('--config <path> is required', 'USAGE')

    return await runDebug(args.debug, { stderr }, async () => {
      const config = await loadConfig(args.config)
      lock = await acquireLock({ repo: config.repo, dir: env.XDG_RUNTIME_DIR || os.tmpdir() })
      if (!lock) {
        stdout.write('Another npm-dep-autopilot instance is already running; exiting\n')
        return 0
      }

      const log = line => stdout.write(`${line}\n`)
      deadline = createDeadline({ deadlineAt: computeDeadline(now(), config.deadline) })
      const { signal } = deadline
      const gh = createGh({ run: runProcess, repo: config.repo, signal })
      await gh.assertLoggedIn()

      const git = createGit({ run: runProcess, repo: config.repo, defaultBranch: config.defaultBranch, signal })
      await git.assertIdentity()
      const tools = createTools({ run: runProcess, repo: config.repo, signal })
      const outcome = await runAutopilot({ config, gh, git, tools, deadline, log })
      log(outcome === 'deadline' ? 'Deadline reached; abandoning current work' : 'No completely solvable findings remain')
      return 0
    })
  }
  catch (error) {
    stderr.write(`npm-dep-autopilot: ${error.message}\n`)
    return 1
  }
  finally {
    deadline?.dispose()
    await lock?.release()
  }
}
