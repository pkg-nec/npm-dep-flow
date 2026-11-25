# Autopilot: close dependencies PRs that fall behind the default branch

Date: 2026-11-25

## Intent and the why

While a `dependencies` pull request from autopilot is open, other pull requests
keep merging into the default branch. One of them can make the dependencies PR
redundant or outdated. For example, it may already bump the same package or
change the lockfile underneath it. Today autopilot polls such a PR every
`pollIntervalSeconds` until someone closes it by hand, and only then plans
again.

The change makes that step automatic. A dependencies PR whose branch is no
longer based on the tip of the default branch is closed, its remote branch is
deleted, and autopilot runs its normal plan-and-upgrade routine as if no PR
were pending. That routine produces a fresh PR based on the current default
branch, or nothing if the other merge already fixed the findings.

## Goals

- On every poll of the wait step (README step 3), detect each open dependencies
  PR whose branch does not contain the current `origin/<defaultBranch>` tip.
- Close each such PR with a comment explaining why, delete its branch on
  origin, and log the close.
- When no open dependencies PRs remain after the closes, leave the wait step
  through the existing path (sync, then a work cycle).
- Keep polling exactly as today for PRs that are still based on the tip.

## Non-goals

- Rebasing or force-pushing a stale PR to keep it alive. A fresh plan is the
  only way to tell whether the PR is still needed.
- Detecting overlap between the other merge and the PR's changes. Any new
  commit on the default branch counts as stale.
- Protecting commits a person pushed to a `deps/*` branch. Those branches
  belong to the app.

## Anti-goals

- Closing a PR that is still based on the tip, for example the PR autopilot
  just published, or a PR whose state is unknown.
- Touching PRs that the app's existing filter does not select, which is open,
  labelled `dependencies`, and authored by the logged-in user.

## Accepted consequence

In a repository where the default branch moves often, a dependencies PR can be
closed and recreated on every merge, and may never stay open long enough to be
reviewed. This was raised and accepted. It is the intended behaviour.

## Approaches

- **A. Git ancestry check after a fetch (chosen).** On each poll,
  `git fetch --prune origin`, list open PRs, and for each run
  `git merge-base --is-ancestor origin/<default> origin/<headRefName>`. Close
  stale ones with `gh pr close --delete-branch` and a comment. This reuses the
  existing `fetch` and `merge-base` patterns in `git.js`, adds a `gh` call only
  when a close is needed, and does not depend on GitHub branch-protection
  settings. It costs one fetch per poll.
- **B. GitHub compare API** (`gh api .../compare/<default>...<branch>`,
  `behind_by > 0`). Needs no fetch, but adds one API call per open PR per poll,
  and the check reflects GitHub's view rather than the clone that publish
  rebases against. Not chosen.
- **C. Rebase and force-push the stale PR.** Keeps the PR alive, but the
  operator's case is that the PR may be redundant after the other merge, and
  only re-planning can tell. Rejected.

## Decided behaviour

- **When it runs:** on every poll iteration of `waitForOpenPrs`, before the
  open-PR list is evaluated. This includes the first poll, so a PR left open
  from an earlier run is checked at startup. (The user chose every poll over
  a once-per-run check.)
- **Stale:** `origin/<defaultBranch>` is not an ancestor of
  `origin/<headRefName>` after a fresh fetch.
- **Several open PRs:** only the stale ones are closed. If any current PR
  remains, autopilot keeps waiting on it.
- **After closing:** the closed PRs are removed from the poll's open list. If
  the list is now empty, the wait returns as it does today when PRs disappear,
  so `runAutopilot` syncs and starts a work cycle. Closed findings may be
  selected again, as with any closed PR.
- **Log line:** `Closed stale PR <url>: <branch> is behind <defaultBranch>`.
  `openPrs` additionally requests `url` in its `--json` fields.
- **Close comment:** a short fixed text saying that the branch fell behind
  `<defaultBranch>` and that autopilot will plan again.

## Decided by Claude (correct if wrong)

- **Branch missing on origin** (no `origin/<headRefName>` after the fetch):
  the PR is not treated as stale and polling continues. It is not closed on
  incomplete information.
- **Failures:** a failed fetch, ancestry check or close in a poll counts toward
  the existing `MAX_POLL_FAILURES` (5 consecutive) limit, the same as a failed
  `gh pr list`. It ends with `GH_UNAVAILABLE`, or a git-specific code if the
  builder finds that clearer. `DeadlineReached` still propagates immediately.
- **The PR just published (`expectBranch`):** needs no special case. Publish
  rebases onto the freshly fetched default branch before pushing, so the PR is
  current unless the default branch moves again, and then closing it is the
  intended behaviour.
- **Version:** `npm-dep-autopilot` minor bump to 0.3.0, in the final commit.
- **Docs:** README "Behavior" step 3 describes the check and the close, and
  the "A pull request that is closed without merging" paragraph mentions that
  autopilot itself closes stale ones.

## Left to the builder

- Adapter shape: for example `git.isBasedOnDefault(branch)` returning
  `true`/`false`/`null` (missing ref) and `gh.closePr(number, comment)`. Check
  whether `gh pr close --delete-branch` fails or warns when no local branch of
  that name exists (local `deps/*` branches are deleted by every sync). If it
  does, delete the remote branch with `git push origin --delete <branch>`
  instead.
- Test coverage in `runner.test.js` (stale is closed and the cycle runs, current
  keeps polling, mixed list, missing branch, close failure counting, the
  default branch moving mid-poll) and in `git.test.js`/`gh.test.js` for the new
  adapter calls, plus an executable test with the fake `gh` if it fits the
  existing harness.
