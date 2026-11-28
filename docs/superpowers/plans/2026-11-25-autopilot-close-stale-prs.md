# Autopilot: close stale dependencies PRs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every poll of the wait step, autopilot closes each open dependencies PR whose branch no longer contains `origin/<defaultBranch>`, deletes its remote branch, and moves on to a fresh work cycle when no PRs remain open.

**Architecture:** Two new adapter calls, `git.isBasedOnDefault(branch)` and `gh.closePr(number, comment)`, plus a step inside `waitForOpenPrs` in `src/runner.js` that fetches, lists, closes stale PRs and drops them from the open list before the existing wait logic runs. There are no new files in `src/`.

**Tech Stack:** Node.js ESM, `node:test`, `git`, and `gh`, called through the existing `run` subprocess abstraction.

**Spec:** `docs/superpowers/specs/2026-11-25-autopilot-close-stale-prs-design.md`

## Global Constraints

- All work is in `tools/npm-dep-autopilot/`. Run `npm ci --ignore-scripts && npm test` there.
- Run lint from the repo root with `npm --prefix dev-tooling ci --ignore-scripts && npm --prefix dev-tooling run lint`. It must report zero warnings, with no rule-disable comments.
- Commit messages use Conventional Commits with scope `autopilot`.
- Version bump `0.2.0` → `0.3.0` (minor). Change only `package.json` and the two root `version` fields of `package-lock.json`, in the final commit.
- Log line, verbatim: `Closed stale PR <url>: <branch> is behind <defaultBranch>`.
- Close comment, verbatim: `Closed by npm-dep-autopilot: this branch is behind <defaultBranch>. A new pull request will be planned from the current <defaultBranch>.`
- Stale means `origin/<defaultBranch>` is not an ancestor of `origin/<headRefName>`. A missing remote branch is not stale.
- Fetch, ancestry and close failures inside a poll count toward `MAX_POLL_FAILURES` (5). `DeadlineReached` propagates immediately.

## Review Focus

1. **Default branch moves while autopilot is polling.** The first poll sees the PR as current and a later poll as stale, so the PR is closed at that later poll. Covered by a runner test in Task 2.
2. **The closed PR still appears in a lagging `gh pr list`.** Its remote branch was pruned, so `isBasedOnDefault` returns `null`. Autopilot must not close it again and keeps waiting. Covered by the git test "missing branch is null" in Task 1 and the runner test "a PR whose branch is missing is not closed" in Task 2.
3. **`gh pr close` fails, for example because of permissions.** The failure is retried, and after 5 consecutive failures autopilot exits with `GH_UNAVAILABLE`, without starting a work cycle. Covered in Task 2.
4. **The default branch was merged into the PR branch instead of rebased.** The branch still contains the default-branch tip, so it is current. Covered in Task 1.
5. **The deadline arrives during a close.** `DeadlineReached` returns `'deadline'` and the counter does not swallow it. Covered in Task 2.

---

### Task 1: Adapter calls for ancestry and closing

**Files:**
- Modify: `tools/npm-dep-autopilot/src/git.js`
- Modify: `tools/npm-dep-autopilot/src/gh.js`
- Test: `tools/npm-dep-autopilot/test/git.test.js`, `tools/npm-dep-autopilot/test/gh.test.js`

**Interfaces:**
- Produces: `git.isBasedOnDefault(branch: string): Promise<true | false | null>`. It returns `null` when `refs/remotes/origin/<branch>` does not exist. It throws `AutopilotError` with code `GIT_FAILED` on any other git error.
- Produces: `gh.closePr(number: number, comment: string): Promise<void>`. It throws `AutopilotError` with code `GH_FAILED` on a non-zero exit.
- Produces: `gh.openPrs(user)` now returns objects shaped like `{ number, headRefName, url }`.

- [ ] **Step 1: Write the failing git tests in `test/git.test.js`.** Each test uses `createRepos()`, pushes a branch from `repos.other`, and then calls `tool.fetch()`:
  - `isBasedOnDefault is true for a branch cut from the current default tip`: branch `deps/web/a` with one commit, pushed. Expect `true`.
  - `isBasedOnDefault is false once the default branch moves`: push `deps/web/a`, then commit to `main` in `other` and push. Expect `false`.
  - `isBasedOnDefault is true after the default branch is merged into the branch`: same setup as the previous test, then `git merge -q --no-edit origin/main` on `deps/web/a` and push. Expect `true`.
  - `isBasedOnDefault is null for a branch missing on origin`: no push. Expect `null` for `'deps/web/none'`.

- [ ] **Step 2: Write the failing gh tests in `test/gh.test.js`.**
  - Update `openPrs lists open dependencies PRs by author`. The expected `--json` value is `'number,headRefName,url'`.
  - `closePr closes with a comment and deletes the branch`: expect args `['pr', 'close', '7', '--comment', 'why', '--delete-branch']`.
  - `closePr throws GH_FAILED on failure`: the fake run returns `{ code: 1, stderr: 'denied' }`.

- [ ] **Step 3: Run the tests to verify they fail.** Run `node --test test/git.test.js test/gh.test.js` from `tools/npm-dep-autopilot`. Expect failures on the new tests and the updated `openPrs` test.

- [ ] **Step 4: Implement both calls.**
  - `isBasedOnDefault`: check the ref with `exec(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/<branch>'])`. A non-zero exit returns `null`. Otherwise run `exec(['merge-base', '--is-ancestor', remoteDefault, 'refs/remotes/origin/<branch>'])`. Exit 0 returns `true`, exit 1 returns `false`, and anything else throws `GIT_FAILED`, as `hasNewDefaultCommits` does.
  - `closePr`: call `execOrThrow` with the args from Step 2.
  - `openPrs`: add `url` to the `--json` field list.

- [ ] **Step 5: Run the tests to verify they pass.** Run `node --test test/git.test.js test/gh.test.js`. Expect all to pass.

- [ ] **Step 6: Commit.**
  ```bash
  git add src/git.js src/gh.js test/git.test.js test/gh.test.js
  git commit -m "feat(autopilot): add PR ancestry check and close adapters"
  ```

### Task 2: Close stale PRs in the wait loop

**Files:**
- Modify: `tools/npm-dep-autopilot/src/runner.js` (`waitForOpenPrs`, and the call in `runAutopilot`)
- Test: `tools/npm-dep-autopilot/test/runner.test.js`

**Interfaces:**
- Consumes: `git.fetch()`, `git.isBasedOnDefault(branch)`, `gh.openPrs(user)` returning `{ number, headRefName, url }`, and `gh.closePr(number, comment)` from Task 1.
- Produces: no new exports. `waitForOpenPrs` keeps returning `waited: boolean`.

- [ ] **Step 1: Extend `makeEnv` in `test/runner.test.js`.**
  - Add the option `based = {}`. It maps a branch name either to an array of results, consumed one per call with the last one repeating, or to a single value. Branches not in the map default to `true`.
  - Add `git.isBasedOnDefault(branch)`. It pushes the event `based:<branch>` and returns the next value. A value that is an `Error` is thrown.
  - Add `closeFails = []`, a queue of booleans or `DeadlineReached` instances.
  - Add `gh.closePr(number, comment)`. It pushes `close:<number>`, records `{ number, comment }` in a returned `closed` array, and throws per `closeFails`.
  - Return `closed` from `makeEnv`.
  - Existing tests must keep passing unchanged. PRs without `headRefName` are treated as current: skip the ancestry check when `headRefName` is absent in the fake, or give such PRs a default branch name in the fake.

- [ ] **Step 2: Write the failing runner tests.** Each test name is followed by its assertions.
  - `a stale PR is closed and a work cycle starts without waiting`: `openPrs: [[{ number: 1, headRefName: 'deps/web/a', url: 'u1' }], []]` and `based: { 'deps/web/a': false }`.
    - `env.closed` equals `[{ number: 1, comment: 'Closed by npm-dep-autopilot: this branch is behind main. A new pull request will be planned from the current main.' }]`.
    - `env.sleeps` equals `[]`.
    - `env.logs` includes `'Closed stale PR u1: deps/web/a is behind main'`.
    - `syncDefault` happens twice, and the second one comes after `close:1` and before `createWorkBranch`.
  - `a current PR is polled, not closed`: the same PR with `based` set to `true` and `openPrs: [[pr], [pr], []]`. `env.closed` is empty and `env.sleeps` equals `[60000, 60000]`.
  - `a PR that falls behind while polling is closed at that poll`: `based: { 'deps/web/a': [true, false] }` and `openPrs: [[pr]]`. `env.closed` has length 1, `env.sleeps` equals `[60000]`, and the run ends `'done'`.
  - `only stale PRs are closed and the wait continues for current ones`: two PRs, `a` (stale) and `b` (current); `openPrs: [[a, b], [b], []]`. Exactly `close:1` happens (once), and `env.sleeps` equals `[60000, 60000]`.
  - `a PR whose branch is missing is not closed`: `based: { 'deps/web/a': null }` and `openPrs: [[pr], []]`. `env.closed` is empty and `env.sleeps` equals `[60000]`.
  - `a fetch is done before every PR list poll`: with `openPrs: [[pr], []]`, every `openPrs` event is immediately preceded by `fetch`.
  - `five consecutive close failures are fatal`: the stale PR is always listed and `closeFails` is always an `Error`. The run rejects with `{ code: 'GH_UNAVAILABLE' }`, `env.sleeps.length` is 4, and `createWorkBranch` never occurs.
  - `a single close failure is retried`: `closeFails: [new Error('x')]`, then success. The run ends `'done'` and `env.closed` has length 1.
  - `the deadline during a close returns deadline`: `closeFails: [new DeadlineReached()]`. The run ends `'deadline'` and `env.sleeps` equals `[]`.

- [ ] **Step 3: Run the tests to verify they fail.** Run `node --test test/runner.test.js`. Expect the new tests to fail.

- [ ] **Step 4: Implement the change in `src/runner.js`.**
  - Add `async function closeStalePrs({ git, gh, config, log }, open): Promise<{ open, closed: number }>`. It goes through the PRs in order. A PR whose `isBasedOnDefault(pr.headRefName)` is `false` is closed with the comment from Global Constraints and logged with the line from Global Constraints. It returns the remaining PRs and the number closed.
  - In `waitForOpenPrs`, the `try` block becomes `await git.fetch()`, then `gh.openPrs(user)`, then `closeStalePrs`. `failures` resets only after all three succeed.
  - If `closed > 0`, set `waited = true`, so the caller syncs to the fetched default branch.
  - If `closed > 0` and the remaining list is empty, return immediately without sleeping. Leave the rest of the loop (expected-branch lag and the sleep) unchanged.
  - Change the fatal message to `Cannot poll open PRs: ${error.message}` and keep the code `GH_UNAVAILABLE`.

- [ ] **Step 5: Run the tests to verify they pass.** Run `npm test` in `tools/npm-dep-autopilot`. Expect all tests to pass, including `cli.test.js`. Its fake `gh pr list` returns `[]`, so it is unaffected.

- [ ] **Step 6: Lint.** Run `npm --prefix dev-tooling run lint` from the repo root. Expect zero problems; apply `lint:fix` if needed.

- [ ] **Step 7: Commit.**
  ```bash
  git add src/runner.js test/runner.test.js
  git commit -m "feat(autopilot): close dependencies PRs that fall behind the default branch"
  ```

### Task 3: Documentation and version bump

**Files:**
- Modify: `tools/npm-dep-autopilot/README.md` (Behavior step 3, the "closed without merging" paragraph, and the Exit codes row "repeated `gh` failures")
- Modify: `tools/npm-dep-autopilot/package.json`, `tools/npm-dep-autopilot/package-lock.json`

- [ ] **Step 1: Update the README.**
  - Step 3 of Behavior gets this new text: "**Wait.** While pull requests labelled `dependencies` and authored by the logged-in user are open, check them every `pollIntervalSeconds`. Each check fetches first; a PR whose branch no longer contains the tip of `origin/<default>` (another merge moved the default branch) is closed with a comment, its branch is deleted on origin, and the app logs `Closed stale PR <url>: <branch> is behind <default>`. A PR whose branch is missing on origin is left alone. When none is open (merged, closed, or closed as stale), sync again and continue."
  - Add a sentence after "A pull request that is closed without merging is treated like a merged one.": "The app closes its own pull requests this way when they fall behind the default branch, so expect a dependencies PR to be replaced after each merge to the default branch."
  - Change the exit-code wording from "repeated `gh` failures" to "repeated failures to poll open pull requests (`gh` or `git fetch`)".

- [ ] **Step 2: Commit the docs.**
  ```bash
  git add README.md
  git commit -m "docs(autopilot): document closing stale dependencies PRs"
  ```

- [ ] **Step 3: Bump the version.** Set `"version": "0.3.0"` in `package.json` and in both root entries of `package-lock.json` (the top-level `version` and `packages[""].version`). Run `npm test` again and expect a pass.

- [ ] **Step 4: Commit the bump.**
  ```bash
  git add package.json package-lock.json
  git commit -m "chore(autopilot): bump version to 0.3.0"
  ```

## Decisions made in this plan

- **No executable test.** The fake `gh` in `cli.test.js` has no PR state. The change sits behind adapter calls that are covered by real-git tests in `git.test.js` and by `runner.test.js`.
- **`gh pr close --delete-branch` is used as is.** gh deletes a local branch only when one exists, and syncs have already deleted the local `deps/*` branches. If a reviewer finds otherwise on the installed gh version, replace it with `gh pr close` followed by `git push origin --delete <branch>`.
