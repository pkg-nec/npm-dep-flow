import { AutopilotError } from './errors.js'

const WORK_BRANCH = 'deps/wip'

export function createGit({ run, repo, defaultBranch, signal, debug }) {
  const exec = args => run('git', args, { cwd: repo, signal, debug })
  const remoteDefault = `origin/${defaultBranch}`

  async function git(args) {
    const result = await exec(args)
    if (result.code !== 0) throw new AutopilotError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`, 'GIT_FAILED')
    return result.stdout
  }

  return {
    async fetch() {
      await git(['fetch', '--prune', 'origin'])
    },
    async isClean() {
      return (await git(['status', '--porcelain', '--untracked-files=no'])).trim() === ''
    },
    async syncDefault() {
      await git(['checkout', '-q', '-B', defaultBranch, remoteDefault])
      const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/deps/'])).split('\n').filter(Boolean)
      for (const branch of branches) await git(['branch', '-q', '-D', branch])
    },
    async createWorkBranch() {
      await git(['checkout', '-q', '-B', WORK_BRANCH])
    },
    async head() {
      return (await git(['rev-parse', 'HEAD'])).trim()
    },
    async resetHard(sha) {
      await git(['reset', '-q', '--hard', sha])
    },
    async subjectsSince() {
      return (await git(['log', '--reverse', '--format=%s', `${remoteDefault}..HEAD`])).split('\n').filter(Boolean)
    },
    async rebaseOnDefault() {
      const result = await exec(['rebase', remoteDefault])
      if (result.code === 0) return true

      await git(['rebase', '--abort'])
      return false
    },
    async hasNewDefaultCommits() {
      const result = await exec(['merge-base', '--is-ancestor', remoteDefault, 'HEAD'])
      if (result.code === 0) return false
      if (result.code === 1) return true
      throw new AutopilotError(`git merge-base failed: ${result.stderr.trim()}`, 'GIT_FAILED')
    },
    async renameBranch(to) {
      await git(['branch', '-q', '-m', to])
    },
    async push(branch) {
      await git(['push', '-q', '-u', '--force-with-lease', 'origin', branch])
    },
    async onWorkBranch() {
      return (await git(['branch', '--show-current'])).trim() === WORK_BRANCH
    },
    async discardWork() {
      await git(['reset', '-q', '--hard'])
      await git(['clean', '-q', '-fd'])
    },
  }
}
