import { debugLog } from './debug.js'
import { AutopilotError, DeadlineReached } from './errors.js'
import { ignoreRecord } from './ignores.js'
import { prBody, prPlan } from './naming.js'
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

// The stored ignores are separate from the runtime skip set, which a restart
// clears, and are reloaded on every selection so a new --ignore is honoured
// without restarting the app.
function createIgnores({ log, loadIgnores }) {
  const matched = new Map()
  let warned = false
  let recorded = null
  let firstReadOfCycle = true

  return {
    startCycle() {
      matched.clear()
      firstReadOfCycle = true
    },
    async read() {
      const { entries, unreadable, path } = await loadIgnores()
      if (unreadable && !warned) log(`Cannot read the ignore store ${path}; continuing with no ignored findings`)
      warned = unreadable
      const record = ignoreRecord(entries)
      if (firstReadOfCycle || record !== recorded) {
        debugLog(`ignores ${record}`)
        recorded = record
        firstReadOfCycle = false
      }
      return entries
    },
    collect(ignored) {
      for (const { project, row } of ignored) {
        // Bare module on purpose: operators paste this after --ignore, and an empty module really is `:<id>`; a relativePath fallback would be rejected.
        matched.set(skipKey(project, row), `${project.module}:${row.id.slice(0, 7)} (${row.package}@${row.version})`)
      }
    },
    report() {
      if (matched.size > 0) log(`Ignoring ${matched.size} finding(s): ${[...matched.values()].join(', ')}`)
    },
  }
}

async function selectFirst({ tools, config }, skip, ignores) {
  const entries = await planEntries(tools, config.projects)
  const stored = await ignores.read()
  let first = null
  // Every severity is ranked even once a candidate is found, so the cycle's
  // ignore report covers what it passed over at any severity.
  for (const severity of SEVERITIES) {
    const { candidates, ignored } = rankCandidates(entries, severity, skip, stored)
    ignores.collect(ignored)
    if (!first && candidates[0]) first = { severity, candidate: candidates[0] }
  }
  return first
}

async function selectDrain({ tools }, batch, skip, ignores) {
  const entries = await planEntries(tools, [batch.project])
  const { candidates, ignored } = rankCandidates(entries, batch.severity, skip, await ignores.read())
  ignores.collect(ignored)
  const [candidate] = drainCandidates(candidates, batch.project.module)
  return candidate ? { severity: batch.severity, candidate } : null
}

async function attemptUpgrade({ tools, git, log }, candidate, skip) {
  const before = await git.head()
  const { project, row, kind } = candidate
  try {
    const report = await tools.upgrade(project, row.id)
    skip.add(skipKey(project, row))
    if (report.commits.length === 0) return null

    return {
      id: report.id,
      severity: row.severity,
      kind,
      package: report.package,
      oldVersion: report.oldVersion,
      actions: report.actions,
      commits: report.commits.map(commit => commit.subject),
    }
  }
  catch (error) {
    if (error instanceof DeadlineReached) throw error
    log(`Upgrade of ${project.module || project.relativePath} ${row.id} failed: ${error.message}`)
    await git.resetHard(before)
    skip.add(skipKey(project, row))
    return null
  }
}

async function publish({ git, gh, config, log }, { module, items, singleFinding }) {
  await git.fetch()
  if (await git.hasNewDefaultCommits() && !await git.rebaseOnDefault()) {
    log('Rebase onto the default branch failed; abandoning unmerged commits')
    return { status: 'restart' }
  }

  const { branch, title } = prPlan({ module, items, singleFinding })
  const body = prBody(items)
  await gh.ensureLabel()
  await git.renameBranch(branch)
  await git.push(branch)
  const url = await gh.createPr({ branch, title, body, base: config.defaultBranch })
  log(`Created PR ${url}: ${title}`)
  return { status: 'published', branch }
}

async function workCycle(context, skip, ignores) {
  const { git } = context
  await git.createWorkBranch()
  ignores.startCycle()

  // DeadlineReached unwinds past report() on purpose: the cycle is abandoned and the next run reports its ignores again.
  const result = await applyUpgrades(context, skip, ignores)
  ignores.report()
  return result
}

async function applyUpgrades(context, skip, ignores) {
  const { log } = context
  let batch = null
  const items = []

  for (;;) {
    const next = batch ? await selectDrain(context, batch, skip, ignores) : await selectFirst(context, skip, ignores)

    if (!next) {
      if (items.length === 0) return { status: 'done' }
      return publish(context, { module: batch.project.module, items, singleFinding: false })
    }

    const { severity, candidate } = next
    const item = await attemptUpgrade(context, candidate, skip)
    if (!item) continue

    items.push(item)
    log(`Upgraded ${candidate.project.module || candidate.project.relativePath} ${candidate.row.package} (${severity})`)
    if (publishesImmediately(item)) {
      return publish(context, { module: candidate.project.module, items, singleFinding: true })
    }
    batch = { project: candidate.project, severity }
  }
}

export async function runAutopilot({ config, gh, git, tools, deadline, log, loadIgnores = async () => ({ entries: [], unreadable: false }) }) {
  const context = { config, gh, git, tools, deadline, log }
  const skip = new Set()
  const ignores = createIgnores({ log, loadIgnores })

  try {
    const user = await gh.currentUser()
    let expectBranch = null
    for (;;) {
      await sync(context)
      if (await waitForOpenPrs({ ...context, user }, expectBranch)) await sync(context)

      const result = await workCycle(context, skip, ignores)
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
