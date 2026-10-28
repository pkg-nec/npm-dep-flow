import { AutopilotError } from './errors.js'

export function createGh({ run, repo, signal, debug }) {
  const exec = args => run('gh', args, { cwd: repo, signal, debug })

  async function execOrThrow(args) {
    const result = await exec(args)
    if (result.code !== 0) throw new AutopilotError(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`, 'GH_FAILED')
    return result.stdout
  }

  return {
    async assertLoggedIn() {
      const result = await exec(['auth', 'status'])
      if (result.code !== 0) throw new AutopilotError('gh has no active login session; run "gh auth login"', 'GH_NOT_LOGGED_IN')
    },
    async currentUser() {
      return (await execOrThrow(['api', 'user', '--jq', '.login'])).trim()
    },
    async openPrs(user) {
      const stdout = await execOrThrow(['pr', 'list', '--state', 'open', '--label', 'dependencies', '--author', user, '--json', 'number,headRefName'])
      return JSON.parse(stdout)
    },
    async createPr({ branch, title, body, base }) {
      const stdout = await execOrThrow(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body, '--label', 'dependencies'])
      return stdout.trim()
    },
    async ensureLabel() {
      const result = await exec(['label', 'create', 'dependencies'])
      if (result.code !== 0 && !result.stderr.includes('already exists')) {
        throw new AutopilotError(`gh label create failed: ${result.stderr.trim()}`, 'GH_FAILED')
      }
    },
  }
}
