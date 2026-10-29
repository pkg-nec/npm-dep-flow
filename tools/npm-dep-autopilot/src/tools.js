import { AutopilotError } from './errors.js'

async function runJson(run, command, args, { repo, signal, debug }) {
  const result = await run(command, args, { cwd: repo, signal, debug, cmdShim: true })
  if (result.code !== 0) {
    throw new AutopilotError(`${command} failed (exit ${result.code}): ${result.stderr.trim()}`, 'TOOL_FAILED')
  }

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

export function createTools({ run, repo, signal, debug }) {
  const context = { repo, signal, debug }

  return {
    async plan(project) {
      const report = await runJson(run, 'npm-dep-upgrade-plan', [project.path, '--format', 'json'], context)
      if (!Array.isArray(report.rows)) throw new AutopilotError('npm-dep-upgrade-plan report has no rows', 'TOOL_OUTPUT')
      return report.rows
    },
    upgrade(project, id) {
      const commitArgs = project.gitCommitArgs.map(arg => `--git-commit-arg=${arg}`)
      return runJson(run, 'npm-dep-upgrade', [project.path, id, ...(project.module === '' ? [] : ['--module', project.module]), ...commitArgs, '--format', 'json'], context)
    },
  }
}
