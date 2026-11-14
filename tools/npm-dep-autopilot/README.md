# npm-dep-autopilot

`npm-dep-autopilot` is an unattended command-line app for a dedicated Linux server. It keeps the npm dependencies of several Node.js projects in one Git repository patched. It chains the other tools in this repository: `npm-dep-upgrade-plan` finds completely solvable vulnerability fixes, `npm-dep-upgrade` applies them as commits, and `git` and `gh` publish pull requests. One process works until nothing completely solvable remains, waiting for its own pull request to be merged between rounds.

## Requirements

- Node.js 20 or newer.
- `npm-dep-paths`, `npm-dep-audit`, `npm-dep-versions`, `npm-dep-upgrade-plan` and `npm-dep-upgrade` installed as standalone commands on `PATH`. The app only calls their command-line interfaces (schema version 3 JSON).
- Git 2.36 or newer and the GitHub CLI `gh`, logged in (`gh auth login`) as the OS user that runs the app.
- A **dedicated clone** of the repository. The app checks out, resets and deletes branches freely (it resets the default branch to `origin/<default>` and deletes local `deps/*` branches), and refuses to start when tracked files are modified. Configure `user.name` and `user.email` in that clone so rebases can run.

Install the tool from its directory:

```sh
npm ci --ignore-scripts
npm install --global . --ignore-scripts
```

## Usage

```sh
npm-dep-autopilot --config /etc/npm-dep-autopilot.json
npm-dep-autopilot --config ./autopilot.json --debug
npm-dep-autopilot --config ./autopilot.json --no-debug
npm-dep-autopilot --config ./autopilot.json --ignore web:a1b2c3d
npm-dep-autopilot --config ./autopilot.json --clear-cache
npm-dep-autopilot --clear-cache
npm-dep-autopilot --help
npm-dep-autopilot --version
```

Progress lines go to stdout.

`--clear-cache` deletes the analysis caches of the tools autopilot runs (planner, audit, paths and versions) by running `npm-dep-upgrade --clear-cache`, which forwards the clearing down its chain. Autopilot keeps no analysis cache of its own, but it does keep [ignored findings](#ignoring-a-finding), and `--clear-cache` removes them too: together with `--config` only that clone's ignores, alone every clone's. Together with `--config` it clears once at startup, after the single-instance, `gh` login and Git identity checks, and then runs normally. Alone, without `--config`, it only clears and exits 0 without taking the lock or needing `gh`. A cache that cannot be cleared is an error (exit 1). Use it when a stale or wrong cached plan keeps the app from seeing a fix; Autopilot has no `--no-cache` or `--cache-ttl`: the planner's cache is keyed on the project's manifest and lockfile content, so syncing after a merge invalidates it, and it lasts one hour by default.

`--debug` logs every external command (`git`, `gh`, `npm-dep-upgrade-plan`, `npm-dep-upgrade`) to stderr, in the same format as the other tools: `[npm-dep-autopilot debug] start <pid>:<n> process {...}` followed by `end <pid>:<n> process exit=<code> duration=<ms>ms`. Credentials in arguments and URLs are redacted, and subprocess output is not logged. Debug mode is passed down to the planner and upgrade tool (`--debug` plus `NPM_DEP_FLOW_DEBUG=1`), and their `[npm-dep-<tool> debug]` records, including those of the tools they run, are relayed to stderr. The stored ignores are logged as one `ignores ...` record listing the entries (module, id and when each was added), at the first read of every work cycle, whenever the effective set changes, and after `--ignore` stores entries. `--no-debug` disables debug logging even when `NPM_DEP_FLOW_DEBUG=1` is inherited from the environment, which otherwise enables it.

## Configuration

```json
{
  "repo": "/srv/repo-a",
  "defaultBranch": "main",
  "pollIntervalSeconds": 60,
  "deadline": "00:00",
  "projects": [
    { "path": "apps/web", "module": "web", "gitCommitArgs": ["--no-verify"] },
    { "path": "apps/api", "module": "api", "gitCommitArgs": ["--no-verify"] }
  ]
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `repo` | Path of the dedicated clone (relative paths resolve against the config file) | required |
| `defaultBranch` | Branch that pull requests target and the app syncs to | required |
| `pollIntervalSeconds` | How often an open pull request is checked | `60` |
| `deadline` | Local time of day (`HH:MM`) at which a running instance abandons its work and exits | `00:00` |
| `projects[].path` | Project directory relative to `repo` | required |
| `projects[].module` | Module name used in commit subjects, branches and PR titles; letters, digits, `.`, `_`, `-` only (it becomes part of a Git branch name). Use `""` for no module; at most one project can | required |
| `projects[].gitCommitArgs` | Git arguments forwarded to `npm-dep-upgrade` (for example `--no-verify`) | `[]` |

Project order is priority order. Unknown keys, invalid values, duplicate modules or paths, and project paths outside `repo` are errors.

## Behavior

1. **Guards.** Take a single-instance lock; if another instance is running, exit 0. Require an active `gh` login, otherwise exit 1.
2. **Sync.** Fetch, require a clean clone, reset the default branch to `origin/<default>` and delete local `deps/*` branches. If a previous run was interrupted on its work branch (`deps/wip`), that unfinished work is discarded first.
3. **Wait.** While pull requests labelled `dependencies` and authored by the logged-in user are open, check them every `pollIntervalSeconds`. When none is open (merged or closed), sync again and continue.
4. **Work.** Run `npm-dep-upgrade-plan` for every project in order. Severities are tried in the order critical, high, moderate, low. Only findings with `resolution: complete` count. Within a severity, Angular toolchain is fixed first, then Angular runtime, then parent upgrades, then within-range updates (ties go to project order). A finding that fails to upgrade is skipped for the rest of the process. Findings [ignored](#ignoring-a-finding) are never selected; once per work cycle in which at least one stored ignore matched, the app logs `Ignoring 2 finding(s): web:a1b2c3d (brace-expansion@5.0.9), api:4c5b6a7 (...)`. The line is not limited to the severity or module that publishes, so it also appears on a cycle that publishes nothing.
5. **Publish.** Fetch; if the default branch has new commits, rebase, and if the rebase fails abandon the unmerged commits and restart from step 2. Then create the `dependencies` label if needed, push (with `--force-with-lease`, because `deps/*` branch names belong to the app and may be reused after an earlier PR) and open the PR. Go back to step 3, which also waits until the new PR shows up in the PR list so a lagging list cannot trigger a second PR.
6. **Exit.** Exit 0 when no completely solvable finding is left, or when `deadline` passes (running child processes and their process groups are stopped (SIGTERM, then SIGKILL after 5 seconds; `taskkill /T /F` on Windows) and local work is abandoned; open pull requests carry over to the next run).

| Case | Branch | PR title |
| --- | --- | --- |
| Angular toolchain | `deps/<module>/angular-toolchain-<v>` | `deps(<module>): bump Angular toolchain to <v>` |
| Angular runtime | `deps/<module>/angular-runtime-<v>` | `deps(<module>): bump Angular runtime to <v>` |
| Critical finding, or one commit in a batch | `deps/<module>/<package>-<v>` | `deps(<module>): bump <package> from <old> to <new>` |
| Several commits in a batch | `deps/<module>/fix-vulnerabilities` | `deps(<module>): fix vulnerabilities` |

With an empty module the `<module>` part is dropped everywhere: titles and commit subjects start with `deps:` instead of `deps(<module>):`, and branches start with `deps/` instead of `deps/<module>/` (for example `deps/fix-vulnerabilities`). Only one project can use an empty module, because two would produce the same branch names.

Critical findings and Angular bumps get one PR each. High, moderate and low fixes drain a module: after the first fix the app keeps taking non-Angular complete findings of the same severity from the same module, then opens one PR. A finding that mixes an Angular action with other actions is published as the Angular bump, with its other commits in the same PR.

A rebase that applies cleanly is not re-verified: the lockfile and manifest are taken as the rebased result, so review the PR before merging as usual.

Each line of a pull request body ends with the finding's seven-digit ID, for example `- deps(web): bump foo from 2.1.0 to 2.4.1 (a1b2c3d)`; titles and branch names are unchanged.

A pull request that is closed without merging is treated like a merged one. Its findings may be found again and a new PR opened on a later run.

## Ignoring a finding

An upgrade that passes the planner and `npm-dep-upgrade` can still break the project in ways the tools cannot see. Merging nothing is not an option for an unattended app, because the same finding would be selected again after the pull request is closed. `--ignore` marks a finding as never to be attempted again:

```sh
npm-dep-autopilot --config ./autopilot.json --ignore web:a1b2c3d
npm-dep-autopilot --config ./autopilot.json --ignore web:a1b2c3d --ignore api:4c5b6a7
npm-dep-autopilot --config ./autopilot.json --ignore :a1b2c3d
```

- The value is `<module>:<id>`. The module is one of the configured `projects[].module` values; use `:<id>` for the project with the empty module. The option is repeatable and also accepted as `--ignore=<value>`.
- The ID is 7 to 64 lowercase hexadecimal characters. It matches a finding of that module when the finding's full ID starts with it, so the seven-digit ID from the pull request is enough. Read it from the end of the pull request body line, for example `- deps(web): bump foo from 2.1.0 to 2.4.1 (a1b2c3d)`, or from `npm-dep-upgrade-plan`.
- The command stores the entries, prints `Ignoring <module>:<id>` (or `Already ignored: <module>:<id>`) and exits 0. It does not take the single-instance lock, need `gh`, touch the clone or run any other tool, so it is safe while another instance is running. A running instance reads the store at every candidate selection, so the entry applies from its next work cycle without a restart.
- **Ignore first, then close the pull request.** A closed pull request is treated like a merged one, so the next cycle may select the same finding again unless the ignore is already in place.
- Entries never expire. They are stored per clone in `$XDG_CACHE_HOME/npm-dep-autopilot/ignored-<digest>.json` (default `~/.cache/npm-dep-autopilot/`), where `<digest>` is the SHA-256 of the JSON-encoded `repo` value. Outside the clone, they survive the resets and branch deletions the app performs.
- The only way to remove an ignore is `--clear-cache`, and it is all-or-nothing: with `--config` it removes that clone's ignores (and the analysis caches), alone it removes every clone's. `--ignore` cannot be combined with `--clear-cache`.
- If the store cannot be read, the run continues with no ignored findings and logs one warning, repeated only if a later read succeeds and then fails again: `Cannot read the ignore store <path>; continuing with no ignored findings`. The consequence is visible: the breaking upgrade is attempted again and lands in the next pull request. Treat the warning as the signal to add the ignore again.

## Scheduling with cron

cron owns the schedule; the app does not run a timer between invocations. It exits immediately when another instance is running, so a long run is never interrupted by the next hourly start. Edit the crontab of the user that is logged in to `gh`:

```sh
crontab -e
```

Run every hour from 06:00 to the last run at 23:00 (local time):

```cron
PATH=/home/deploy/.nvm/versions/node/v24/bin:/usr/local/bin:/usr/bin:/bin
0 6-23 * * * npm-dep-autopilot --config /etc/npm-dep-autopilot.json >> "$HOME/npm-dep-autopilot.log" 2>&1
```

- Change the first and last hours in `6-23`, and the interval with a step, for example `0 6-22/2 * * *` for every two hours.
- cron runs with a minimal environment: set `PATH` so `node`, `git`, `gh` and every `npm-dep-*` command resolve, or use absolute paths.
- The built-in lock already makes overlapping starts harmless. To add a second guard, prefix the command with `flock -n /tmp/npm-dep-autopilot.lock`.
- The 00:00 cutoff is the `deadline` setting, independent of cron.

List the installed schedule with `crontab -l`.

## Exit codes

| Code | Situation |
| --- | --- |
| 0 | Nothing left to fix, another instance is running, or the deadline was reached |
| 1 | Invalid config or arguments (including an `--ignore` value that is not `<module>:<id>` with a 7 to 64 digit lowercase hexadecimal ID, a module that is not configured, or `--ignore` together with `--clear-cache`), a cache that cannot be cleared, no `gh` login, no Git committer identity in the clone, a modified clone, repeated `gh` failures, or an unexpected tool error |

Upgrade failures and rebase failures are handled inside the run and are not exit conditions.

## Tests

```sh
npm ci --ignore-scripts
npm test
```

The executable tests use real Git repositories with fake `gh`, `npm-dep-upgrade-plan` and `npm-dep-upgrade` commands on `PATH`, and are skipped on Windows.
