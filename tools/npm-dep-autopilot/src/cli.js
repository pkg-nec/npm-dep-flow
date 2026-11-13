import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { computeDeadline, createDeadline } from './deadline.js'
import { debugLog, runDebug } from './debug.js'
import { AutopilotError } from './errors.js'
import { createGh } from './gh.js'
import { createGit } from './git.js'
import { clearAllStores, clearStore } from './cache-clear.js'
import { addIgnores, cacheRoot, ignoreRecord, readIgnores } from './ignores.js'
import { acquireLock } from './lock.js'
import { runAutopilot } from './runner.js'
import { runProcess } from './subprocess.js'
import { createTools } from './tools.js'

const toolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const helpBody = `Usage: npm-dep-autopilot --config <path> [options]
       npm-dep-autopilot --clear-cache

Keeps npm dependencies patched: plans and applies vulnerability fixes with the
npm-dep tools, then pushes branches and opens pull requests through gh.

Options:
  --config <path>         JSON configuration file (required unless only clearing caches)
  --clear-cache           Delete analysis caches (planner, audit, paths, versions); without --config, only clear
  --ignore <module>:<id>  Never attempt this finding again; cleared only by --clear-cache
  --debug                 Log external actions to stderr, including planner and upgrade
  --no-debug              Disable debug logging, overriding NPM_DEP_FLOW_DEBUG
  --version               Show version and tool directory
  --help                  Show this help
`

function parseIgnore(value) {
  const colon = value.indexOf(':')
  if (colon === -1) throw new AutopilotError(`Invalid --ignore value "${value}": expected <module>:<id>`, 'USAGE')
  const id = value.slice(colon + 1)
  if (!/^[0-9a-f]{7,64}$/.test(id)) {
    throw new AutopilotError(`Invalid --ignore value "${value}": the id must be 7 to 64 lowercase hexadecimal characters`, 'USAGE')
  }
  return { module: value.slice(0, colon), id }
}

function parseArgs(argv) {
  const args = { config: null, debug: undefined, clearCache: false, ignore: [] }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') {
      index += 1
      if (index >= argv.length) throw new AutopilotError('--config needs a path', 'USAGE')
      args.config = argv[index]
    }
    else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length)
    else if (arg === '--ignore' || arg.startsWith('--ignore=')) {
      let value = arg.slice('--ignore='.length)
      if (arg === '--ignore') {
        index += 1
        if (index >= argv.length) throw new AutopilotError('--ignore needs a <module>:<id> value', 'USAGE')
        value = argv[index]
      }
      args.ignore.push(parseIgnore(value))
    }
    else if (arg === '--clear-cache') {
      if (args.clearCache) throw new AutopilotError('Repeated --clear-cache option', 'USAGE')
      args.clearCache = true
    }
    else if (arg === '--debug' || arg === '--no-debug') {
      if (args.debug !== undefined) throw new AutopilotError('Repeated debug option', 'USAGE')
      args.debug = arg === '--debug'
    }
    else throw new AutopilotError(`Unknown argument: ${arg}`, 'USAGE')
  }

  if (args.ignore.length > 0 && args.clearCache) throw new AutopilotError('--ignore cannot be combined with --clear-cache', 'USAGE')

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
    if (!args.config && !args.clearCache) throw new AutopilotError('--config <path> is required', 'USAGE')

    return await runDebug(args.debug, { stderr }, async () => {
      if (!args.config) {
        await clearAllStores(cacheRoot(env))
        await createTools({ run: runProcess, repo: process.cwd() }).clearCache()
        stdout.write('Analysis caches cleared\n')
        return 0
      }

      const config = await loadConfig(args.config)
      if (args.ignore.length > 0) {
        const modules = config.projects.map(project => project.module)
        for (const { module } of args.ignore) {
          if (!modules.includes(module)) {
            throw new AutopilotError(`Unknown module "${module}" in --ignore; configured modules: ${modules.map(name => `"${name}"`).join(', ')}`, 'USAGE')
          }
        }
        const { added, duplicates } = await addIgnores(config.repo, args.ignore, cacheRoot(env))
        for (const { module, id } of added) stdout.write(`Ignoring ${module}:${id}\n`)
        for (const { module, id } of duplicates) stdout.write(`Already ignored: ${module}:${id}\n`)
        debugLog(`ignores ${ignoreRecord((await readIgnores(config.repo, cacheRoot(env))).entries)}`)
        return 0
      }

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
      if (args.clearCache) {
        await clearStore(config.repo, cacheRoot(env))
        await tools.clearCache()
        log('Analysis caches cleared')
      }

      const outcome = await runAutopilot({ config, gh, git, tools, deadline, log, loadIgnores: () => readIgnores(config.repo, cacheRoot(env)) })
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
