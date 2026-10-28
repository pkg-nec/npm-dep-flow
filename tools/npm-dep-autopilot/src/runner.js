import { AutopilotError, DeadlineReached } from './errors.js'
import { prPlan } from './naming.js'
import { drainCandidates, publishesImmediately, rankCandidates, SEVERITIES, skipKey } from './selector.js'

const MAX_POLL_FAILURES = 5
const MAX_LISTING_LAG_POLLS = 3

async function sync({ git, log }) {
  await git.fetch()
  if (await git.onWorkBranch()) {
    log('Discarding interrupted work on the work branch')
    await git.discardWork()
  }
  if (!await git.isClean()) throw new AutopilotError('The clone has tracked changes; the app needs a dedicated clone', 'CLONE_DIRTY')
  await git.syncDefault()
}

async function waitForOpenPrs({ gh, deadline, config, user, log }, expectBranch) {
  let expected = expectBranch
  let waited = false
  let failures = 0
  let lagPolls = 0

  for (;;) {
    let open = null
    try {
      open = await gh.openPrs(user)
      failures = 0
    }
    catch (error) {
      if (error instanceof DeadlineReached) throw error
      failures += 1
      if (failures >= MAX_POLL_FAILURES) throw new AutopilotError(`gh is unavailable: ${error.message}`, 'GH_UNAVAILABLE')
    }

    if (open && expected && open.some(pr => pr.headRefName === expected)) expected = null
    if (open && expected && lagPolls < MAX_LISTING_LAG_POLLS) {
      lagPolls += 1
      log(`Waiting for the new PR ${expected} to appear in the PR list`)
    }
    else if (open?.length === 0) return waited
    else if (open) log(`Waiting for ${open.length} open dependencies PR(s)`)
    waited = true
    await deadline.sleep(config.pollIntervalSeconds * 1000)
  }
}

async function planEntries(tools, projects) {
  const entries = []
  for (const project of projects) {
    for (const row of await tools.plan(project)) entries.push({ project, row })
  }
  return entries
}

async function selectFirst({ tools, config }, skip) {
  const entries = await planEntries(tools, config.projects)
  for (const severity of SEVERITIES) {
    const [candidate] = rankCandidates(entries, severity, skip)
    if (candidate) return { severity, candidate }
  }
  return null
}

async function selectDrain({ tools }, batch, skip) {
  const entries = await planEntries(tools, [batch.project])
  const [candidate] = drainCandidates(rankCandidates(entries, batch.severity, skip), batch.project.module)
  return candidate ? { severity: batch.severity, candidate } : null
}

async function attemptUpgrade({ tools, git, log }, candidate, skip) {
  const before = await git.head()
  const { project, row } = candidate
  try {
    const report = await tools.upgrade(project, row.id)
    skip.add(skipKey(project, row))
    return report.commits.length === 0 ? null : report
  }
  catch (error) {
    if (error instanceof DeadlineReached) throw error
    log(`Upgrade of ${project.module} ${row.id} failed: ${error.message}`)
    await git.resetHard(before)
    skip.add(skipKey(project, row))
    return null
  }
}

async function publish({ git, gh, config, log }, { module, kind, reports, singleFinding }) {
  await git.fetch()
  if (await git.hasNewDefaultCommits() && !await git.rebaseOnDefault()) {
    log('Rebase onto the default branch failed; abandoning unmerged commits')
    return { status: 'restart' }
  }

  const { branch, title } = prPlan({ module, kind, reports, singleFinding })
  const body = (await git.subjectsSince()).map(subject => `- ${subject}`).join('\n')
  await gh.ensureLabel()
  await git.renameBranch(branch)
  await git.push(branch)
  const url = await gh.createPr({ branch, title, body, base: config.defaultBranch })
  log(`Created PR ${url}: ${title}`)
  return { status: 'published', branch }
}

async function workCycle(context, skip) {
  const { git, log } = context
  await git.createWorkBranch()

  let batch = null
  const reports = []

  for (;;) {
    const next = batch ? await selectDrain(context, batch, skip) : await selectFirst(context, skip)

    if (!next) {
      if (reports.length === 0) return { status: 'done' }
      return publish(context, { module: batch.project.module, kind: 'package', reports, singleFinding: false })
    }

    const { severity, candidate } = next
    const report = await attemptUpgrade(context, candidate, skip)
    if (!report) continue

    reports.push(report)
    log(`Upgraded ${candidate.project.module} ${candidate.row.package} (${severity})`)
    if (publishesImmediately(severity, candidate)) {
      return publish(context, { module: candidate.project.module, kind: candidate.kind, reports, singleFinding: true })
    }
    batch = { project: candidate.project, severity }
  }
}

export async function runAutopilot({ config, gh, git, tools, deadline, log }) {
  const context = { config, gh, git, tools, deadline, log }
  const skip = new Set()

  try {
    const user = await gh.currentUser()
    let expectBranch = null
    for (;;) {
      await sync(context)
      if (await waitForOpenPrs({ ...context, user }, expectBranch)) await sync(context)

      const result = await workCycle(context, skip)
      if (result.status === 'done') return 'done'
      if (result.status === 'restart') skip.clear()
      expectBranch = result.status === 'published' ? result.branch : null
    }
  }
  catch (error) {
    if (error instanceof DeadlineReached) return 'deadline'
    throw error
  }
}
