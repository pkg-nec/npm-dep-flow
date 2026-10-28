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
npm-dep-autopilot --help
npm-dep-autopilot --version
```

`--debug` logs every external command (start and end records) to stderr. Progress lines go to stdout.

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
| `projects[].module` | Module name used in commit subjects, branches and PR titles | required |
| `projects[].gitCommitArgs` | Git arguments forwarded to `npm-dep-upgrade` (for example `--no-verify`) | `[]` |

Project order is priority order. Unknown keys, invalid values, duplicate modules or paths, and project paths outside `repo` are errors.

## Behavior

1. **Guards.** Take a single-instance lock; if another instance is running, exit 0. Require an active `gh` login, otherwise exit 1.
2. **Sync.** Fetch, require a clean clone, reset the default branch to `origin/<default>` and delete local `deps/*` branches.
3. **Wait.** While pull requests labelled `dependencies` and authored by the logged-in user are open, check them every `pollIntervalSeconds`. When none is open (merged or closed), sync again and continue.
4. **Work.** Run `npm-dep-upgrade-plan` for every project in order. Severities are tried in the order critical, high, moderate, low. Only findings with `resolution: complete` count. Within a severity, Angular toolchain is fixed first, then Angular runtime, then parent upgrades, then within-range updates (ties go to project order). A finding that fails to upgrade is skipped for the rest of the process.
5. **Publish.** Fetch; if the default branch has new commits, rebase, and if the rebase fails abandon the unmerged commits and restart from step 2. Then push, create the `dependencies` label if needed and open the PR, and go back to step 3.
6. **Exit.** Exit 0 when no completely solvable finding is left, or when `deadline` passes (running child processes are stopped and local work is abandoned; open pull requests carry over to the next run).

| Case | Branch | PR title |
| --- | --- | --- |
| Angular toolchain | `deps/<module>/angular-toolchain-<v>` | `deps(<module>): bump Angular toolchain to <v>` |
| Angular runtime | `deps/<module>/angular-runtime-<v>` | `deps(<module>): bump Angular runtime to <v>` |
| Critical finding, or one commit in a batch | `deps/<module>/<package>-<v>` | `deps(<module>): bump <package> from <old> to <new>` |
| Several commits in a batch | `deps/<module>/fix-vulnerabilities` | `deps(<module>): fix vulnerabilities` |

Critical findings and Angular bumps get one PR each. High, moderate and low fixes drain a module: after the first fix the app keeps taking non-Angular complete findings of the same severity from the same module, then opens one PR. A finding that mixes an Angular action with other actions is published as the Angular bump, with its other commits in the same PR.

A pull request that is closed without merging is treated like a merged one. Its findings may be found again and a new PR opened on a later run.

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
| 1 | Invalid config or arguments, no `gh` login, a modified clone, repeated `gh` failures, or an unexpected tool error |

Upgrade failures and rebase failures are handled inside the run and are not exit conditions.

## Tests

```sh
npm ci --ignore-scripts
npm test
```

The executable tests use real Git repositories with fake `gh`, `npm-dep-upgrade-plan` and `npm-dep-upgrade` commands on `PATH`, and are skipped on Windows.
