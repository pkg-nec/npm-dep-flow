import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { computeDeadline, createDeadline } from './deadline.js'
import { AutopilotError } from './errors.js'
import { createGh } from './gh.js'
import { createGit } from './git.js'
import { acquireLock } from './lock.js'
import { runAutopilot } from './runner.js'
import { runProcess } from './subprocess.js'
import { createTools } from './tools.js'

const toolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const HELP = `Usage: npm-dep-autopilot --config <path> [--debug]

Keeps npm dependencies patched: plans and applies vulnerability fixes with the
npm-dep tools, then pushes branches and opens pull requests through gh.

Options:
  --config <path>  JSON configuration file (required)
  --debug          Log external actions to stderr
  --help           Show this help
  --version        Show the version and installed directory
`

function parseArgs(argv) {
  const args = { config: null, debug: false, help: false, version: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      index += 1
      if (index >= argv.length) throw new AutopilotError('--config needs a path', 'USAGE')
      args.config = argv[index]
    }
    else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length)
    else if (arg === '--debug') args.debug = true
    else if (arg === '--help') args.help = true
    else if (arg === '--version') args.version = true
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
    const args = parseArgs(argv)
    if (args.help) {
      stdout.write(HELP)
      return 0
    }
    if (args.version) {
      stdout.write(`npm-dep-autopilot ${await toolVersion()}\n${toolDir}\n`)
      return 0
    }
    if (!args.config) throw new AutopilotError('--config <path> is required', 'USAGE')

    const config = await loadConfig(args.config)
    lock = await acquireLock({ repo: config.repo, dir: env.XDG_RUNTIME_DIR || os.tmpdir() })
    if (!lock) {
      stdout.write('Another npm-dep-autopilot instance is already running; exiting\n')
      return 0
    }

    const debug = args.debug ? line => stderr.write(`[debug] ${line}\n`) : undefined
    const log = line => stdout.write(`${line}\n`)
    deadline = createDeadline({ deadlineAt: computeDeadline(now(), config.deadline) })
    const { signal } = deadline
    const gh = createGh({ run: runProcess, repo: config.repo, signal, debug })
    await gh.assertLoggedIn()

    const git = createGit({ run: runProcess, repo: config.repo, defaultBranch: config.defaultBranch, signal, debug })
    const tools = createTools({ run: runProcess, repo: config.repo, signal, debug })
    const outcome = await runAutopilot({ config, gh, git, tools, deadline, log })
    log(outcome === 'deadline' ? 'Deadline reached; abandoning current work' : 'No completely solvable findings remain')
    return 0
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
