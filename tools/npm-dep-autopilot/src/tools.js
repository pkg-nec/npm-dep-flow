import { AutopilotError } from './errors.js'

const RELAYED_DEBUG_LINE = /^\[npm-dep-[a-z-]+ debug\] .*$/gm

async function runChecked(run, command, args, { repo, signal }) {
  const result = await run(command, args, { cwd: repo, signal, cmdShim: true })
  if (result.code !== 0) {
    const shown = [command, ...args.filter(arg => arg === '--clear-cache')].join(' ')
    throw new AutopilotError(`${shown} failed (exit ${result.code}): ${result.stderr.replace(RELAYED_DEBUG_LINE, '').trim()}`, 'TOOL_FAILED')
  }

  return result
}

async function runJson(run, command, args, context) {
  const result = await runChecked(run, command, args, context)

  let report
  try {
    report = JSON.parse(result.stdout)
  }
  catch (error) {
    throw new AutopilotError(`${command} printed invalid JSON: ${error.message}`, 'TOOL_OUTPUT')
  }
  if (report?.schemaVersion !== 3) throw new AutopilotError(`${command} printed an unsupported schema version`, 'TOOL_OUTPUT')

  return report
}

export function createTools({ run, repo, signal }) {
  const context = { repo, signal }

  return {
    async plan(project) {
      const report = await runJson(run, 'npm-dep-upgrade-plan', [project.path, '--format', 'json'], context)
      if (!Array.isArray(report.rows)) throw new AutopilotError('npm-dep-upgrade-plan report has no rows', 'TOOL_OUTPUT')
      return report.rows
    },
    async clearCache() {
      await runChecked(run, 'npm-dep-upgrade', ['--clear-cache'], context)
    },
    upgrade(project, id) {
      const commitArgs = project.gitCommitArgs.map(arg => `--git-commit-arg=${arg}`)
      return runJson(run, 'npm-dep-upgrade', [project.path, id, ...(project.module === '' ? [] : ['--module', project.module]), ...commitArgs, '--format', 'json'], context)
    },
  }
}
