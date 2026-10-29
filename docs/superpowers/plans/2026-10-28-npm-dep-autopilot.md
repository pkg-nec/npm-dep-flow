# npm-dep-autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tools/npm-dep-autopilot/`, a long-running CLI that repeatedly plans, fixes and publishes dependency-vulnerability PRs for the projects of one repository using the existing tools, `git` and `gh`.

**Architecture:** Small ESM modules with injected adapters (subprocess, clock, `gh`, `git`, tools). A pure `selector`/`naming` core decides what to fix and how to name PRs; `runner` wires the adapters into the lifecycle (guards, sync, wait, work, publish). No state persists between runs.

**Tech Stack:** Node.js >=20, ESM, `node --test`, no runtime dependencies (same layout as `tools/npm-dep-versions`: `bin/`, `src/`, `test/`, `package.json` with `"type": "module"`, no semicolons, single quotes).

**Spec:** `docs/superpowers/specs/2026-10-28-npm-dep-autopilot-design.md`

## Global Constraints

- Node.js 20 or newer for the CLI; develop with Node 24. No dependency on sibling tools' source; they are called only as `npm-dep-upgrade-plan` / `npm-dep-upgrade` on `PATH` with `--format json` (schema version 3).
- Shared lint must pass with zero warnings; no rule-disable comments, no personal overrides. Run `npm --prefix dev-tooling run lint` from the repository root after every JavaScript task.
- Portable subprocess launching: Windows runs `<name>.cmd` through a shell for `npm-dep-*` commands; Unix-like systems spawn directly. `git` and `gh` are spawned directly on every platform.
- Exit codes: 0 for nothing left to fix, another instance running, or the deadline reached; 1 for invalid config, no `gh` login, unclean clone, repeated `gh` failures, or unexpected error.
- PR label is exactly `dependencies`. Branch and title formats are exactly those in the spec's naming table.
- Severity order `critical, high, moderate, low`; strategy rank `upgrade-angular-toolchain`, `upgrade-angular-runtime`, `upgrade-via-parent-dependency`, `update-within-declared-range`.
- Commit messages and PR titles use Conventional Commits. Version `0.1.0` is set only in the final commit, in `package.json` and `package-lock.json`.
- Work on branch `feat/npm-dep-autopilot` in its own worktree under `worktrees/`, created from `main` after this spec/plan branch is merged (or stacked on `docs/autopilot-design`).

## Review Focus

- Skip-set key collision: the same package at the same location in two projects yields the same planner `id`; the skip key must include the module. (Task 3)
- An upgrade that fails after committing a prefix leaves commits on the work branch; the runner must reset to the pre-attempt HEAD before trying the next candidate. (Task 6)
- Two or more open `dependencies` PRs: wait until all are closed or merged, not just the first. (Task 6)
- Scoped package names (`@scope/pkg`) in branch names and titles must stay valid Git refs. (Task 3)
- Lock file left by a crashed process (dead PID) must not block future runs; a live PID must. (Task 5)
- Deadline during a wait or a child process must stop promptly and exit 0 without pushing. (Tasks 2, 6)

## File Structure

```
tools/npm-dep-autopilot/
  package.json  package-lock.json  README.md
  bin/npm-dep-autopilot.js
  src/{cli,config,errors,deadline,subprocess,lock,gh,git,tools,selector,naming,runner}.js
  test/{config,deadline,subprocess,lock,gh,git,tools,selector,naming,runner,cli}.test.js
  test/helpers/{fake-bin.js,repo.js}
```

---

### Task 1: Scaffold, lint scope and config loader

**Files:**
- Create: `tools/npm-dep-autopilot/{package.json,package-lock.json,bin/npm-dep-autopilot.js,src/errors.js,src/config.js,test/config.test.js}`
- Modify: `dev-tooling/eslint.config.mjs:16,27` (add `npm-dep-autopilot` to both `tools/{…}` globs)

**Interfaces:**
- Produces: `class AutopilotError extends Error { constructor(message, code) }` and `class DeadlineReached extends Error` (both in `src/errors.js`); `loadConfig(configPath: string): Promise<Config>` where `Config = { repo: string, defaultBranch: string, pollIntervalSeconds: number, deadline: string /* 'HH:MM' */, projects: { path: string /* absolute */, relativePath: string, module: string, gitCommitArgs: string[] }[] }`.

- [ ] **Step 1: Write failing tests** in `test/config.test.js` (temp dirs via `fs.mkdtemp(os.tmpdir())`): valid file resolves `repo` and project `path` absolute (relative `repo` resolves against the config file's directory) and applies defaults `pollIntervalSeconds: 60`, `deadline: '00:00'`, `gitCommitArgs: []`; each of these rejects with `AutopilotError` whose message names the key: unknown top-level key, unknown project key, missing `repo`/`defaultBranch`/`projects`, empty `projects`, duplicate `module`, duplicate `path`, project path `../outside` escaping `repo`, `pollIntervalSeconds` of `0` or `1.5`, `deadline` of `'24:00'` or `'7:5'`, `gitCommitArgs` not an array of strings, unreadable file, invalid JSON.
- [ ] **Step 2: Run** `cd tools/npm-dep-autopilot && node --test test/config.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Create** `package.json` (`name`, `version: "0.0.0"`, `private: true`, `type: module`, `bin`, `engines.node: ">=20"`, `scripts.test: "node --test"`, no dependencies), generate `package-lock.json` with `npm install --package-lock-only --ignore-scripts`, a `bin` stub identical in shape to `npm-dep-versions/bin/npm-dep-versions.js` importing `main` from `../src/cli.js` (cli arrives in Task 7; the stub may exist now), `src/errors.js`, and `src/config.js`. Validate with explicit checks and no schema library.
- [ ] **Step 4: Update the lint globs** in `dev-tooling/eslint.config.mjs` and run `npm --prefix dev-tooling ci --ignore-scripts && npm --prefix dev-tooling run lint` from the repo root. Expected: zero warnings.
- [ ] **Step 5: Run** the config tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(autopilot): scaffold package and config loader`.

### Task 2: Deadline and subprocess runner

**Files:**
- Create: `src/deadline.js`, `src/subprocess.js`, `test/deadline.test.js`, `test/subprocess.test.js`

**Interfaces:**
- Consumes: `DeadlineReached` from `src/errors.js`.
- Produces:
  - `computeDeadline(now: Date, hhmm: string): Date` — the next local occurrence of `hhmm` strictly after `now`.
  - `createDeadline({ deadlineAt: Date, now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }): { signal: AbortSignal, expired(): boolean, sleep(ms: number): Promise<void>, dispose(): void }` — `signal` aborts with a `DeadlineReached` reason at `deadlineAt`; `sleep` resolves after `ms` or rejects with `DeadlineReached` if the deadline comes first or already passed.
  - `runProcess(command: string, args: string[], options: { cwd?: string, signal?: AbortSignal, cmdShim?: boolean, spawnImpl?: typeof spawn, platform?: string, debug?: (line: string) => void }): Promise<{ code: number | null, stdout: string, stderr: string }>` — when `cmdShim` and `platform === 'win32'` run `` `${command}.cmd ${args.join(' ')}` `` with `shell: true`; otherwise spawn directly. Abort kills the child and rejects with the signal's reason. `debug` receives start and end records (command, args, cwd, duration, exit status).

- [ ] **Step 1: Write failing tests.** Deadline: `computeDeadline(new Date(2026, 9, 28, 10, 0), '00:00')` is `2026-10-29 00:00` local; at exactly `00:00` the result is the next day; `'23:00'` at 22:00 is the same day. `createDeadline` with fake timers: `sleep(1000)` resolves when its timer fires; the deadline timer firing first rejects `sleep` with `DeadlineReached` and aborts `signal`; `sleep` after expiry rejects immediately; `dispose()` clears timers. Subprocess: with a fake `spawnImpl`, `platform: 'win32'` and `cmdShim: true` spawns `'npm-dep-upgrade.cmd <args joined>'` with `shell: true`; `platform: 'linux'` spawns `command` with the arg array; `cmdShim: false` on win32 spawns directly; stdout/stderr collected and `code` returned; abort kills the child and rejects with `DeadlineReached`; a spawn error rejects.
- [ ] **Step 2: Run** `node --test test/deadline.test.js test/subprocess.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules per the signatures above. Model `runProcess` on `tools/npm-dep-versions/src/process.js` (reuse its structure, not its source).
- [ ] **Step 4: Run** the two tests plus repo lint. Expected: PASS, zero warnings.
- [ ] **Step 5: Commit** `feat(autopilot): add deadline and portable subprocess runner`.

### Task 3: Selector and naming (pure core)

**Files:**
- Create: `src/selector.js`, `src/naming.js`, `test/selector.test.js`, `test/naming.test.js`

**Interfaces:**
- Produces (selector):
  - `SEVERITIES: readonly string[]`, `STRATEGY_RANK: readonly string[]`.
  - `skipKey(project: { module: string }, row: { id: string }): string` — `` `${module}:${id}` ``.
  - `rankCandidates(entries: { project: Project, row: PlannerRow }[], severity: string, skip: Set<string>): Candidate[]` where `Candidate = { project, row, kind: 'toolchain' | 'runtime' | 'package' }`. Keeps rows with `row.severity === severity`, `row.resolution === 'complete'` and key not in `skip`; `kind` comes from the strongest strategy among `row.choices` (toolchain > runtime; anything else is `package`); sorted by strategy rank, ties keep `entries` order (config project order).
  - `publishesImmediately(severity: string, candidate: Candidate): boolean` — true for `critical` or kind `toolchain`/`runtime`.
  - `drainCandidates(candidates: Candidate[], module: string): Candidate[]` — candidates of that module with kind `package` only.
- Produces (naming): `prPlan({ module: string, kind: 'toolchain' | 'runtime' | 'package', reports: UpgradeReport[], singleFinding: boolean }): { branch: string, title: string }` following the spec table. Angular kinds use the anchor action (`strategy` `upgrade-angular-toolchain` / `upgrade-angular-runtime`) `targetVersion`. `package` kind: if total `commits.length` across `reports` is 1, or kind is critical single report, use the first action of the first report (`targetPackage`, `currentVersion`, `targetVersion`); several commits yields `deps/<module>/fix-vulnerabilities` and `deps(<module>): fix vulnerabilities`. `singleFinding: true` (critical findings) forces the single-package form even when that finding made several commits.
  - `UpgradeReport` fields used: `package`, `oldVersion`, `actions[]` (`strategy`, `targetPackage`, `currentVersion`, `targetVersion`), `commits[]`. **First step of Task 3's implementation:** open `tools/npm-dep-upgrade/src/report.js` and `src/cli.js:91` and confirm these field names, and which of the planned/actual target version fields to use; keep one fixture upgrade report in `test/helpers` copied from that shape.

- [ ] **Step 1: Write failing tests.** Selector: with rows across critical/high and strategies, `rankCandidates(..., 'high', skip)` returns only complete high rows ordered toolchain, runtime, parent, within-range; a toolchain+within-range row has kind `toolchain`; equal-rank rows keep project order; a row whose `skipKey` is in `skip` is dropped while the same `id` in another module is kept; `partial` and `none` rows are dropped; rows with severity `info` or unknown never appear; `publishesImmediately('critical', pkgCandidate)` true, `('high', pkgCandidate)` false, `('low', toolchainCandidate)` true; `drainCandidates` excludes other modules and Angular kinds. Naming: toolchain → `deps/web/angular-toolchain-20.3.4` and `deps(web): bump Angular toolchain to 20.3.4`; runtime likewise; single package → `deps/web/brace-expansion-5.0.12` and `deps(web): bump brace-expansion from 5.0.9 to 5.0.12`; three commits → `deps/web/fix-vulnerabilities` and `deps(web): fix vulnerabilities`; `@scope/pkg` yields `deps/web/@scope/pkg-1.2.3` and `git check-ref-format --branch` accepts it (assert via `execFileSync`); a critical finding with two commits and `singleFinding: true` keeps the package form.
- [ ] **Step 2: Run** `node --test test/selector.test.js test/naming.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules; pure functions, no I/O.
- [ ] **Step 4: Run** tests and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): add finding selection and PR naming`.

### Task 4: Adapters for tools, git and gh

**Files:**
- Create: `src/tools.js`, `src/git.js`, `src/gh.js`, `test/tools.test.js`, `test/git.test.js`, `test/gh.test.js`, `test/helpers/repo.js` (creates a bare remote plus a clone in a temp dir and returns paths)

**Interfaces:**
- Consumes: `runProcess` from Task 2 (injected as `run` with the same signature).
- Produces:
  - `createTools({ run, repo: string, signal?: AbortSignal, debug? }): { plan(project): Promise<PlannerRow[]>, upgrade(project, id: string): Promise<UpgradeReport> }`. `plan` runs `npm-dep-upgrade-plan <project.path> --format json`; `upgrade` runs `npm-dep-upgrade <project.path> <id> --module <module> --git-commit-arg=<arg>… --format json` (both with `cmdShim: true`, cwd `repo`). Both parse stdout, require `schemaVersion === 3`, and throw `AutopilotError` (code `TOOL_FAILED` for non-zero exit, `TOOL_OUTPUT` for invalid JSON/schema) including stderr text.
  - `createGit({ run, repo, defaultBranch, signal? }): { fetch(): Promise<void>, isClean(): Promise<boolean>, syncDefault(): Promise<void>, createWorkBranch(): Promise<void> /* deps/wip */, head(): Promise<string>, resetHard(sha: string): Promise<void>, subjectsSince(): Promise<string[]> /* commits on work branch not on default */, rebaseOnDefault(): Promise<boolean> /* fetches nothing; false after `rebase --abort` on conflict */, hasNewDefaultCommits(): Promise<boolean> /* after fetch, origin/<default> not an ancestor of HEAD */, renameBranch(to: string): Promise<void>, push(branch: string): Promise<void> }`. `syncDefault` checks out the default branch, `reset --hard origin/<default>`, and deletes every local `deps/*` branch. `isClean` uses `git status --porcelain --untracked-files=no`.
  - `createGh({ run, repo, signal? }): { assertLoggedIn(): Promise<void>, currentUser(): Promise<string>, openPrs(user: string): Promise<{ number: number, headRefName: string }[]>, createPr({ branch, title, body, base }): Promise<string /* URL */>, ensureLabel(): Promise<void> }`. Commands: `gh auth status`; `gh api user --jq .login`; `gh pr list --state open --label dependencies --author <user> --json number,headRefName`; `gh pr create --base <base> --head <branch> --title <title> --body <body> --label dependencies`; `gh label create dependencies` treating a stderr containing `already exists` as success (never `--force`).

- [ ] **Step 1: Write failing tests.** tools/gh with a fake `run` recording calls: exact argv for each command above (including `--git-commit-arg=--no-verify` and no `--git-commit-arg` when the list is empty); non-zero exit throws `TOOL_FAILED` containing stderr; non-JSON stdout and `schemaVersion: 2` throw `TOOL_OUTPUT`; `assertLoggedIn` throws `AutopilotError` code `GH_NOT_LOGGED_IN` on non-zero; `ensureLabel` ignores `already exists` but throws on other failures. git with real repos from `helpers/repo.js` (local bare remote, `git` real): `syncDefault` after a remote commit fast-forwards and removes `deps/old`; `hasNewDefaultCommits` false then true after another clone pushes; `rebaseOnDefault` returns true for non-conflicting work and false, leaving no rebase in progress and the work branch intact, for conflicting work; `resetHard` removes commits made after a recorded `head()`; `renameBranch`/`push` publish `deps/web/x-1.0.0` to the remote; `isClean` false with a modified tracked file.
- [ ] **Step 2: Run** `node --test test/tools.test.js test/git.test.js test/gh.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the three adapters over `run` (git and gh with `cmdShim: false`). Git identity for rebases comes from the clone's own config; set nothing globally.
- [ ] **Step 4: Run** tests and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): add git, gh and tool adapters`.

### Task 5: Single-instance lock

**Files:**
- Create: `src/lock.js`, `test/lock.test.js`

**Interfaces:**
- Produces: `acquireLock({ repo: string, dir?: string /* default $XDG_RUNTIME_DIR or os.tmpdir() */, pid?: number, isAlive?: (pid: number) => boolean }): Promise<{ release(): Promise<void> } | null>` — returns `null` when another live instance holds it. Lock file name `npm-dep-autopilot-<sha256(repo) first 16 hex>.lock` holding the PID, created with flag `wx`. Default `isAlive` is `process.kill(pid, 0)` (EPERM counts as alive).

- [ ] **Step 1: Write failing tests** with a temp `dir`: first acquire returns a handle and writes the PID; second acquire with the first still held returns `null`; after `release()` a new acquire succeeds; a lock file whose PID `isAlive` reports dead is taken over; unreadable/garbage lock contents count as stale; different `repo` values do not conflict.
- [ ] **Step 2: Run** `node --test test/lock.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `acquireLock`; on stale takeover remove then retry `wx` once to avoid races.
- [ ] **Step 4: Run** test and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): add single-instance lock`.

### Task 6: Runner lifecycle

**Files:**
- Create: `src/runner.js`, `test/runner.test.js`

**Interfaces:**
- Consumes: `Config` (Task 1), `createDeadline` handle (Task 2), selector/naming (Task 3), `tools`/`git`/`gh` adapters (Task 4).
- Produces: `runAutopilot({ config, gh, git, tools, deadline, log: (line: string) => void }): Promise<'done' | 'deadline'>`. Throws `AutopilotError` for unclean clone (`CLONE_DIRTY`) and after 5 consecutive `openPrs` failures (`GH_UNAVAILABLE`). The lifecycle is exactly spec steps 2–6: sync (`git.fetch`, `git.isClean`, `git.syncDefault`), wait (poll `gh.openPrs(user)` every `config.pollIntervalSeconds` through `deadline.sleep` until empty, then sync again), work (`git.createWorkBranch`, selection loop, drain rule, skip set keyed by `skipKey`), publish (`git.fetch`, `hasNewDefaultCommits` → `rebaseOnDefault`; on `false` discard and restart from sync; else `renameBranch`, `push`, `ensureLabel`, `createPr` with `prPlan` and a body listing `subjectsSince()` one per line, then wait). Catches `DeadlineReached` anywhere and returns `'deadline'`, leaving the clone as it is. Returns `'done'` when no severity yields a candidate and no commits are pending. Before each `tools.upgrade`, record `git.head()`; on error, `git.resetHard(thatSha)`, add the skip key and continue. After each successful upgrade re-plan that project before choosing the next candidate.

- [ ] **Step 1: Write failing tests** with fake adapters and a fake deadline (scripted `sleep`): (a) open PR at start → polled until empty, then work proceeds, with `syncDefault` called again between; (b) two open PRs with one closing first → keeps waiting until both are gone; (c) critical candidate beats a high one even in a later project, and one critical commit publishes immediately with the `deps/<module>/<pkg>-<v>` branch and title; (d) three high non-Angular findings in module `web` then none left → one PR `fix-vulnerabilities`; an Angular high finding is never in that batch and is picked first next cycle; (e) a mixed Angular + parent finding is published as the Angular PR; (f) `tools.upgrade` throwing after a commit → `resetHard` called with the pre-attempt HEAD, the key is skipped, the next candidate is tried, and the same `id` in another module is still eligible; (g) `rebaseOnDefault` false → no push, restarts from sync, skip set kept; (h) `DeadlineReached` thrown during `sleep` and during `tools.upgrade` → returns `'deadline'` with `push` and `createPr` never called; (i) dirty clone rejects `CLONE_DIRTY`; five consecutive `openPrs` failures reject `GH_UNAVAILABLE` while a single failure is retried; (j) no candidates anywhere → `'done'` and no PR; (k) `createPr` receives `base: config.defaultBranch` and `ensureLabel` runs before it.
- [ ] **Step 2: Run** `node --test test/runner.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `runAutopilot`; keep the loop as small named helpers (`syncAndWait`, `selectNext`, `publish`) in the same file, each taking the adapters.
- [ ] **Step 4: Run** tests and lint. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): add runner lifecycle`.

### Task 7: CLI wiring and executable tests

**Files:**
- Create: `src/cli.js`, `test/cli.test.js`, `test/helpers/fake-bin.js` (writes executable shell-script fakes for `gh`, `npm-dep-upgrade-plan`, `npm-dep-upgrade` into a temp dir put first on `PATH`)
- Modify: `bin/npm-dep-autopilot.js` (final form: `process.exitCode = await main(process.argv.slice(2))`)

**Interfaces:**
- Consumes: everything above.
- Produces: `main(argv: string[], env?: NodeJS.ProcessEnv): Promise<number>`. Options: `--config <path>` (required), `--debug`, `--help`, `--version` (prints tool version and installed directory like the sibling tools). Order: parse args → `loadConfig` → `acquireLock` (null → exit 0 with a message) → `gh.assertLoggedIn` (failure → exit 1) → `createDeadline(computeDeadline(new Date(), config.deadline))` → `runAutopilot` → release lock and dispose deadline in `finally`. `AutopilotError` and unexpected errors print `npm-dep-autopilot: <message>` to stderr and return 1; `'done'` and `'deadline'` return 0. Log lines go to stdout, debug records to stderr.

- [ ] **Step 1: Write failing tests** (unit with injected adapters where cheap; executable ones spawn `node bin/npm-dep-autopilot.js` and are skipped on `win32`): `--help` output lists every option with descriptions aligned to one column, at least two spaces after the longest label (inspect the rendered text); missing `--config` → exit 1; invalid config → exit 1 and nothing run; second instance while the lock is held → exit 0 and no `gh` call; fake `gh auth status` failing → exit 1; end-to-end with a real temp clone and bare remote, fake `gh` (records `pr create` argv to a file) and fake tools (planner returns one complete critical row; upgrade creates a real commit and prints a schema 3 report) → exit 0 after the PR was created and the fake `gh pr list` returns empty on the next poll with `pollIntervalSeconds: 1` and the planner then returning no rows; recorded `pr create` has `--label dependencies`, the expected `--title`, and the pushed branch exists on the remote.
- [ ] **Step 2: Run** `node --test test/cli.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/cli.js` with a hand-written argument parser (no dependencies), matching the help layout of `npm-dep-upgrade-plan --help`.
- [ ] **Step 4: Run** `npm test` in the tool directory, `node bin/npm-dep-autopilot.js --help` (inspect alignment), and repo lint. Expected: all PASS, zero warnings.
- [ ] **Step 5: Commit** `feat(autopilot): add CLI entry point`.

### Task 8: Documentation, CI and release version

**Files:**
- Create: `tools/npm-dep-autopilot/README.md`, `.github/workflows/npm-dep-autopilot.yml`
- Modify: `README.md` (tool table and design/plan links), `AGENTS.md` (add a "Working on npm-dep-autopilot" section: entry point, adapters, how to test), `CONTRIBUTING.md` only if its tool list names each tool
- Modify (final commit only): `tools/npm-dep-autopilot/package.json` and `package-lock.json` root metadata `version` → `0.1.0`

- [ ] **Step 1: Write the README**: purpose, requirements (all five tools plus `git`, `gh` on `PATH`; `gh auth login` done by the same OS user as cron), config reference table copied from the spec, lifecycle and PR rules summary, exit codes, the crontab setup (`crontab -e`, line `0 6-23 * * * cd /srv/repo-a && /usr/bin/env npm-dep-autopilot --config /etc/npm-dep-autopilot.json >> $HOME/npm-dep-autopilot.log 2>&1`, how to change first/last hour and interval, that `PATH` must be set in the crontab or the line must use absolute paths, optional `flock -n` wrapper), the dedicated-clone requirement, and the accepted limitation about closed PRs.
- [ ] **Step 2: Add the CI workflow** modelled on `.github/workflows/npm-dep-versions.yml` (matrix `ubuntu-latest`, `windows-latest`; working directory `tools/npm-dep-autopilot`; `npm ci --ignore-scripts` then `npm test`; same pinned action SHAs), and update repository docs.
- [ ] **Step 3: Verify** `npm test`, `npm --prefix dev-tooling run lint`, and `node bin/npm-dep-autopilot.js --help`. Expected: all pass, zero warnings.
- [ ] **Step 4: Commit docs and CI** as `docs(autopilot): document setup and cron usage` and `ci: test npm-dep-autopilot` (two commits).
- [ ] **Step 5: Bump the version** to `0.1.0` in `package.json` and `package-lock.json` (root metadata), rerun `npm ci --ignore-scripts && npm test`, and commit as `chore(autopilot): release 0.1.0`.
- [ ] **Step 6: Open the PR** with a Conventional Commits title such as `feat(autopilot): add unattended dependency-fix PR runner`.

## Intended commits (in order)

1. `docs: add npm-dep-autopilot design` and plan (already on `docs/autopilot-design`)
2. `feat(autopilot): scaffold package and config loader` (includes the lint-scope change)
3. `feat(autopilot): add deadline and portable subprocess runner`
4. `feat(autopilot): add finding selection and PR naming`
5. `feat(autopilot): add git, gh and tool adapters`
6. `feat(autopilot): add single-instance lock`
7. `feat(autopilot): add runner lifecycle`
8. `feat(autopilot): add CLI entry point`
9. `docs(autopilot): document setup and cron usage`
10. `ci: test npm-dep-autopilot`
11. `chore(autopilot): release 0.1.0`
