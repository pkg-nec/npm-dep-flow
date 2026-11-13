# npm-dep-autopilot design

## Purpose

`npm-dep-autopilot` is an unattended command-line app for a dedicated Linux Mint server. It keeps the npm dependencies of several Node.js projects inside one Git repository ("repo A") patched. It chains the existing tools, `npm-dep-upgrade-plan` and `npm-dep-upgrade`, and uses `git` and an already logged-in `gh` to push branches and open pull requests. cron starts it hourly. A single process works until nothing completely solvable remains, waiting for its own pull request to be merged between rounds.

It is a new independent package, `tools/npm-dep-autopilot/`, with its own manifest, lockfile, executable, source, tests and README. It talks to other tools only through their documented command-line output (planner and upgrade schema version 3 JSON) and never imports their source. It requires `npm-dep-paths`, `npm-dep-audit`, `npm-dep-versions`, `npm-dep-upgrade-plan` and `npm-dep-upgrade`, plus `git` and `gh`, on `PATH`.

## Decisions

- Schedule is owned by cron, not by the app. The README documents the crontab entry (default `0 6-23 * * *`, first run 06:00, last run 23:00, hourly) and how to change it. There is no `install-cron` helper.
- If another instance is running, the new invocation exits 0 and the running one continues.
- The clone is dedicated to the app. The app may check out, reset and delete branches freely.
- No state is persisted between runs. Git and GitHub are the source of truth. Findings that fail to upgrade are skipped in memory for the current process only.
- A pull request closed without merging is handled like a merged one. Its findings may be rediscovered and a new PR opened on a later run; this is accepted.
- A finding that mixes Angular and non-Angular actions is handled as the Angular bump: the PR is named for the Angular bump and the other commits ride along.
- High, moderate and low fixes drain a module before a PR is opened.

## Configuration

JSON file passed with `--config <path>`. Relative paths in it are resolved against the config file's directory.

```json
{
  "repo": "/srv/repo-a",
  "defaultBranch": "main",
  "pollIntervalSeconds": 60,
  "deadline": "00:00",
  "projects": [
    { "path": "apps/web", "module": "web", "gitCommitArgs": ["--no-verify"] }
  ]
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `repo` | Path of the dedicated clone | required |
| `defaultBranch` | Branch PRs target and the app syncs to | required |
| `pollIntervalSeconds` | PR status poll interval | `60` |
| `deadline` | Local time-of-day cutoff (`HH:MM`) | `00:00` |
| `projects[].path` | Project directory relative to `repo` | required |
| `projects[].module` | Module name for commits, branches and PR titles | required |
| `projects[].gitCommitArgs` | Arguments forwarded as `--git-commit-arg=<arg>` | `[]` |

Project order is priority order. Unknown keys, invalid types, duplicate modules or paths, paths outside `repo`, and unreadable or invalid JSON fail with exit 1 before any work. `gitCommitArgs` values are validated by `npm-dep-upgrade`.

## Lifecycle

1. **Guards.** Take a single-instance lock (a lock file in the user's runtime directory, released on exit). If held, exit 0. Run `gh auth status`; if there is no active login, exit 1. Compute the deadline: the next local occurrence of `deadline`.
2. **Sync.** `git fetch origin`. Require the clone to be clean (no tracked changes). Check out the default branch, hard-reset it to `origin/<defaultBranch>`, and delete leftover local `deps/*` branches. An unclean tree is an error (exit 1) so manual edits are never lost.
3. **Wait.** List open PRs with label `dependencies` authored by the current `gh` user. While any are open, re-check every `pollIntervalSeconds`. When none are open (merged or closed), return to step 2, then continue.
4. **Work.** Run the selection loop below on a temporary branch `deps/wip` created from the synced default branch.
5. **Publish.** When the PR shape is complete: `git fetch origin`. If the default branch has new commits, rebase the work branch onto it. If the rebase fails, abort it, discard the work branch and restart from step 2. Otherwise rename the branch to its final name, push, open the PR with the `dependencies` label against the default branch, and go to step 3.
6. **Exit.** When no candidate remains in any severity, exit 0. When the deadline passes, at any step including waits, terminate child processes, abandon local work and exit 0. Any open PR remains for the next day.

Transient `gh` or network errors while polling are retried on the next tick; several consecutive failures exit 1. Child processes receive the deadline abort signal so long upgrades stop at the cutoff.

## Selection

For each severity in the order critical, high, moderate, low:

1. Run `npm-dep-upgrade-plan <project> --format json` for each project in config order. A candidate is a row whose `severity` equals the current severity, whose `resolution` is `complete`, and whose `id` is not in the in-memory skip set.
2. Rank candidates by the strongest strategy among the row's `choices`: `upgrade-angular-toolchain`, then `upgrade-angular-runtime`, then `upgrade-via-parent-dependency`, then `update-within-declared-range`. Ties go to config project order.
3. Run `npm-dep-upgrade <project> <id> --module <module> --git-commit-arg=<arg>… --format json` for the top candidate on the work branch. If it fails, add the `id` to the skip set and take the next candidate. If none remain at this severity, continue with the next severity.

Planner output is cached by the planner; after each successful upgrade the app re-plans the affected project, since its lockfile changed.

## Batching and naming

| Case | PR timing | Branch | PR title |
| --- | --- | --- | --- |
| Angular toolchain finding | after that finding's commits | `deps/<module>/angular-toolchain-<v>` | `deps(<module>): bump Angular toolchain to <v>` |
| Angular runtime finding | after that finding's commits | `deps/<module>/angular-runtime-<v>` | `deps(<module>): bump Angular runtime to <v>` |
| Critical, non-Angular | after that finding's commits | `deps/<module>/<package>-<v>` | `deps(<module>): bump <package> from <old> to <new>` |
| High/moderate/low, one commit total | module drained | `deps/<module>/<package>-<v>` | `deps(<module>): bump <package> from <old> to <new>` |
| High/moderate/low, several commits | module drained | `deps/<module>/fix-vulnerabilities` | `deps(<module>): fix vulnerabilities` |

Rules:

- If a finding has both an Angular choice and other choices, it is treated as the Angular bump. The toolchain label wins over runtime if both occur. `<v>` is the Angular anchor's target version.
- For high, moderate and low, after the first non-Angular finding in a module, the app keeps taking non-Angular complete findings of the same severity from that same module until none remain, then publishes. Angular findings are never added to a batch; they rank first in the next cycle.
- A critical finding with several commits (several actions) is still one PR for that finding; it is named after the package and target version from the upgrade report.
- Package and version values come from the `npm-dep-upgrade` JSON report, not from parsing commit subjects. The report's `package`, `oldVersion`, `actions` and `commits` fields are the documented inputs; the implementation plan must confirm the exact action version fields against the report schema before relying on them.
- Every PR has the `dependencies` label. The label is created if missing.
- Commit subjects come from `npm-dep-upgrade --module`, for example `deps(<module>): bump <package> from <old> to <new>`.

## Components

Each unit has one purpose and is testable alone.

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `config` | Load and validate the config file | none |
| `lock` | Single-instance guard | none |
| `deadline` | Injectable clock, deadline computation, abort signal | none |
| `gh` | Auth check, current user, PR list, PR create, label | subprocess launcher |
| `git` | Fetch, reset, branch, rebase, rename, push | subprocess launcher |
| `tools` | Run planner and upgrade, parse schema 3 JSON | subprocess launcher |
| `subprocess` | Portable launching (Windows `.cmd` through a shell, direct spawn elsewhere), abort support | none |
| `selector` | Pure: candidate filtering, ranking, batching decisions | none |
| `naming` | Pure: branch names and PR titles | none |
| `runner` | The lifecycle above, wiring all units | all |

`src/cli.js` parses arguments (`--config`, `--help`, `--version`, `--debug`) and calls `runner`. `--debug` logs external actions to stderr like the other tools. Progress and results are logged to stdout or stderr lines; the app produces no report format.

## Exit codes

| Code | Situation |
| --- | --- |
| 0 | Nothing left to fix, another instance running, or deadline reached |
| 1 | Invalid config, no `gh` login, unclean clone, repeated `gh` failures, or unexpected tool error |

Upgrade failures and rebase failures are not exit conditions; they are handled as described above.

## Testing

- Unit tests for `config`, `selector`, `naming` and `deadline`.
- `runner` tests with fake adapters and a fake clock covering: waiting on an open PR, merged and closed transitions, the deadline during work and during waiting, rebase failure restart, skip-set behaviour, drain-module batching, mixed Angular findings, and the no-candidates exit.
- Executable tests running the real CLI with fake `gh`, `git` and tool executables on `PATH`, including both subprocess launch paths (Windows `.cmd` shell path and Unix direct spawn).
- Shared lint with zero warnings; `npm test` from the tool directory.

## Delivery and documentation

- README for the tool: requirements, config reference, crontab examples, behaviour, exit codes. Link it from the repository README tool table.
- Version `0.1.0` set in `package.json` and `package-lock.json` in the final planned commit.
- Commit and PR titles follow Conventional Commits.
