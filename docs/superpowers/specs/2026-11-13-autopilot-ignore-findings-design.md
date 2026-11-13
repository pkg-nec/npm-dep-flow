# `--ignore`: letting autopilot skip a finding that breaks the project

Date: 2026-11-13

## Intent and the why

A dependency upgrade that `npm-dep-upgrade-plan` reports as completely solvable
can still break the project it is applied to. Today that blocks
`npm-dep-autopilot`: it opens a pull request containing the breaking upgrade,
then waits on that pull request forever. Closing the pull request does not
help, because the finding is planned again on the next cycle and the same pull
request comes back. The operator cannot always fix the break at once, and in
the meantime every other fix in the queue is stuck behind it.

The operator needs to mark one finding as "do not attempt," so autopilot moves
past it and keeps fixing everything else.

The mark must survive process restarts, never expire on its own, and be removed
only by `--clear-cache`. A long-running instance that is currently waiting on a
pull request must pick up a new mark without being stopped and restarted.

### The operator's workflow this serves

1. Autopilot is waiting on an open `dependencies` pull request, either one it
   just pushed or one left overnight.
2. The operator sees in that pull request that one or more of the upgrades
   break the project. Each commit line in the pull request body carries the
   finding's seven-digit ID.
3. The operator runs
   `npm-dep-autopilot --config /etc/npm-dep-autopilot.json --ignore web:a1b2c3d`
   while the other instance keeps running.
4. The operator closes the pull request on GitHub.
5. The waiting instance stops waiting, syncs, and starts a new work cycle that
   skips the ignored findings. The new pull request does not contain them.

The order matters: ignore first, then close the pull request. Closing first can
let autopilot start a new cycle before the ignore is stored.

## Goals

- One command adds an ignore and exits, without disturbing a running instance.
- A running instance honours a new ignore from its next work cycle, with no
  restart.
- Ignores never expire. Only `npm-dep-autopilot --clear-cache` removes them,
  and it removes all of them.
- An ignored finding is skipped quietly. It is not reported as an upgrade
  failure and does not cost an upgrade attempt.
- Autopilot's own log names the findings it is ignoring, once per work cycle,
  so the operator can see the standing ignores in the log they already read.
- Every commit line in a pull request body carries its finding ID, so the
  operator has the value `--ignore` needs without running the planner. Running
  `npm-dep-upgrade-plan` by hand stays a valid way to get the same ID.

## Non-goals

- Removing a single ignore. `--clear-cache` removes all of them. A targeted
  `--unignore` can be added later if the all-or-nothing removal proves
  annoying.
- A dedicated command that lists the stored ignores. The per-cycle log line and
  the debug record described below cover inspection for now.
- Listing ignored findings in the pull request body. This was designed and then
  dropped: deciding what "this pull request's scope" means for the
  single-finding Angular and critical pull requests, which never drain a batch,
  cost more than the disclosure was worth, and it left ignored findings
  undisclosed whenever a cycle published nothing at all. The log line covers
  the same need in one place, for every cycle, published or not.
- Changing `npm-dep-upgrade-plan`, `npm-dep-upgrade`, or any JSON report
  schema. The planner keeps reporting an ignored finding as a normal,
  completely solvable finding, because it is one.
- Ignoring a finding for manual `npm-dep-upgrade` runs. An operator who types
  the upgrade command is deliberately asking for that upgrade.
- Per-version or expiring ignores. See the anti-goals.

## Anti-goals

These would make the feature a failure even if it worked:

- An ignore that quietly lapses, so a breaking upgrade returns without the
  operator doing anything. A new release or a new advisory for the same package
  and location must not lift an ignore.
- An ignored finding that shows up in the log as `Upgrade of … failed`, burying
  real failures.
- Ignores stored inside the dedicated clone, where `git reset`/branch deletion
  or a fresh clone would destroy them.
- A commit line in a pull request body carrying the wrong finding's ID, which
  would send the operator to ignore an upgrade that was never the problem.
- A run that honours no ignores without saying so, so the operator reads a log
  that looks normal while a breaking upgrade is being attempted again.

## Constraints

- `npm-dep-autopilot` is an independent package. It may only call the other
  tools through their command-line interfaces and must never import sibling
  private modules.
- Node.js 20 or newer, ESM, shared `dev-tooling` ESLint config with zero
  warnings.
- The `--ignore` command must work while another instance holds the
  single-instance lock, so it must not take the lock.
- It must not need `gh`, a network, or a clean clone. In the operator's
  workflow the clone is sitting on the work branch `deps/wip` with the breaking
  upgrade already applied.
- Windows portability of the code, even though the executable tests are skipped
  there.
- Existing exit-code contract: 0 for normal outcomes, 1 for configuration,
  argument and unrecoverable errors.

## Approaches

Three places could own the ignore. The operator and I compared them before
choosing.

### A. Autopilot owns it (chosen)

Autopilot stores the ignores and filters them out when it selects the next
finding. It already keeps an in-process skip set keyed `<module>:<id>`
(`src/selector.js`), so the persistent ignores feed the same filter.

- Only one tool changes. No JSON schema changes.
- Each ignore is scoped to a project, which matters because the same finding ID
  can occur in two projects and in two repositories.
- The planner and `npm-dep-upgrade` still report and apply the finding when run
  by hand, which is correct: the finding really is there.
- Trade-off: a manual `npm-dep-upgrade` run is not protected.

### B. The planner owns it

The planner would store ignores and mark ignored rows in its report; the
upgrade tool would refuse them and autopilot would filter them out.

- One list that every tool respects.
- Rejected: it changes three tools and the schema-version-3 report. The
  planner's cache is keyed on manifest and lockfile content, so the ignores
  would need to be a separate layer on top of that cache anyway. Worse,
  `npm-dep-upgrade <id> --clear-cache` already clears the planner cache before
  planning, so a routine cache refresh would silently delete every ignore.

### C. The upgrade tool owns it

`npm-dep-upgrade` would store ignores and exit 1 with an `IGNORED` error.

- Protects manual runs, and autopilot would need no change because it already
  catches a failed upgrade.
- Rejected: it hits the first anti-goal above. Every cycle autopilot would
  plan, launch an upgrade and reset the branch for each ignored finding, and
  log it as a failure. Making those quiet means changing autopilot after all,
  which was the only reason to prefer C.

A combination of A and C was considered and set aside as unnecessary for the
operator's workflow.

## Current behaviour this builds on

- `src/selector.js` exposes `skipKey(project, row)` = `` `${project.module}:${row.id}` ``
  and `rankCandidates(entries, severity, skip)`, which keeps rows with
  `resolution === 'complete'` of one severity whose key is not in `skip`.
- `src/runner.js` holds `skip`, a `Set` of runtime skips (an upgrade that
  failed, or one already applied this run), cleared only when a failed rebase
  forces a restart. `selectFirst` walks the severities critical, high,
  moderate, low across all projects in config order; `selectDrain` keeps taking
  non-Angular findings of the same module and severity.
- `publish()` builds the pull request body from `git.subjectsSince()`, one
  `- <subject>` line per commit on the work branch.
- `prPlan()` in `src/naming.js` chooses the branch and title from the upgrade
  reports.
- Each upgrade report (schema version 3) carries `id`, `package`, `oldVersion`,
  `targetLocation` and an ordered `commits[]` of `{ hash, subject }`.
- Autopilot has no cache directory of its own. `--clear-cache` runs
  `npm-dep-upgrade --clear-cache`, which forwards the clearing down the chain.
- The sibling tools each own `$XDG_CACHE_HOME/<tool>` (default
  `~/.cache/<tool>`) and delete that whole directory on `--clear-cache`.

## Design

### The ignore store

One JSON file per clone, in autopilot's own cache directory
`$XDG_CACHE_HOME/npm-dep-autopilot` (default `~/.cache/npm-dep-autopilot`),
named `ignored-<digest>.json`. `<digest>` is `sha256(JSON.stringify(repo))`
as 64 hexadecimal characters, with `repo` the clone's resolved absolute path.
This matches the sibling tools' `result-<digest>.json` naming, which uses the
same full-length digest of a JSON-stringified key
(`tools/npm-dep-paths/src/result-cache.js`). Living in that directory is what
lets `--clear-cache` remove the files, as the operator asked.

```
~/.cache/npm-dep-autopilot/ignored-04354e3e2069a8c06fa0f5511af8839133d424c79df07279b84d55260dfa2187.json
```

```json
{
  "version": 1,
  "repo": "/srv/repo-a",
  "entries": [
    { "module": "web", "id": "a1b2c3d", "addedAt": "2026-11-13T09:12:04.000Z" },
    { "module": "api", "id": "0d1e2f3a4b5c6d7e", "addedAt": "2026-11-14T22:03:51.000Z" },
    { "module": "", "id": "4c5b6a7", "addedAt": "2026-11-15T08:40:12.000Z" }
  ]
}
```

Two fields the sibling caches carry are deliberately absent. There is no
`createdAt`/`freshAt`/`expiresAt` triple, because that is the expiry machinery
this store must not have. There is no `checksum` either: a cache entry failing
its checksum is harmlessly refetched, but an ignore list failing one is
silently lost and the breaking upgrade returns. Writes are atomic through a
temporary file and a rename, so a torn file should not arise, and a corrupt one
almost certainly fails to parse in any case.

- `repo` is the absolute, resolved clone path from the loaded config. The
  filename hash already separates clones; this field keeps the file readable by
  a human and lets a run confirm it opened the right file. A file whose `repo`
  does not match the running config is treated as unreadable (see "Loading").
- `module` is the project's configured module, `""` for the empty-module
  project.
- `id` is stored exactly as the operator typed it: a lowercase hexadecimal
  string of 7 to 64 characters, usually the seven-digit short form.
- `addedAt` is informational only. Nothing reads it to decide anything; it
  exists so the operator can see how old an entry is in the debug record.
- `version` is written as `1` and is not used to decide anything either. There
  is no case of two autopilot versions running against one machine's store, so
  nothing branches on it; it exists only so a future format change has somewhere
  to declare itself. A version autopilot does not know is handled like any other
  unreadable store, under "Loading" below.
- Writes go through a temporary file and an atomic rename, creating the
  directory if needed. Two concurrent `--ignore` commands are last-writer-wins;
  this is documented and not otherwise guarded, because the command is a rare
  manual action.

**Why the stored ID is a prefix and not resolved to a full ID.** Resolving a
prefix would require running the planner, and in the operator's workflow the
clone is sitting on `deps/wip` with the breaking upgrade already applied, so
the planner would no longer list the finding and resolution would fail exactly
when it is needed. Storing the typed prefix also keeps the command instant and
offline. A finding matches an entry when the module is equal and the row's full
ID starts with the entry's ID. Seven hexadecimal digits within a single module
make an unintended match very unlikely, and the operator can store a longer
prefix when they want certainty.

### The `--ignore` command

```
npm-dep-autopilot --config <path> --ignore <module>:<id> [--ignore <module>:<id>]…
```

- `--ignore=<value>` is accepted too, like `--config=`.
- The value is `<module>:<id>`, the same key autopilot already uses internally.
  For the empty-module project the value is `:<id>`.
- `--ignore` requires `--config`: the module must be validated against the
  configured projects and the entry is stored against the config's `repo`.
- Repeating `--ignore` is allowed and adds several entries in one invocation,
  because a single pull request often contains more than one breaking upgrade.
- The command **does not** start a work cycle. It validates, writes, prints one
  line per added entry to stdout, and exits 0. It does not take the
  single-instance lock, does not require `gh`, does not touch the clone, and
  does not run any sibling tool, so it is safe while another instance is
  running.
- Writing is read, append, write: the command reads the clone's store, appends
  the new entries, and writes the whole file back. It uses exactly the same
  reader as a run, so an unreadable store reads as zero entries and the write
  rebuilds the file holding only the new entries. Nothing readable is lost,
  because nothing in it was readable, and there is no separate repair path.
- Adding an entry that is already stored for the same module and ID is a
  no-op reported as already ignored, exit 0. Overlapping prefixes are not
  merged: with `a1b2c3d` already stored, `--ignore web:a1b2c3d4ef` adds a
  second entry. Both match the same finding, which is harmless.
- Validation errors exit 1 with a `USAGE` or `CONFIG_INVALID` diagnostic:
  a value without `:`, an ID that is not 7 to 64 lowercase hexadecimal
  characters, or a module that no configured project uses.
- `--ignore` combined with `--clear-cache` is rejected as a usage error. The
  two would otherwise race in one command for no good reason.

### Loading, and picking up new ignores mid-run

- The store is read once at startup, before the first work cycle, and again at
  the start of every candidate selection (`selectFirst` and `selectDrain` in
  `src/runner.js`). That read is a single small file read, so doing it per
  selection is cheap and removes any need to watch the file.
- In the operator's workflow, closing the pull request ends the wait, autopilot
  syncs and starts a work cycle, and the very first selection in that cycle
  already sees the new ignores. No restart is needed.
- The file read is the one for the running config's clone, so entries for other
  clones are never in play.
- A missing file means no ignores, silently. That is the normal state before
  the first `--ignore` and after `--clear-cache`.
- **A store that cannot be read means zero entries, and the caller continues.**
  This covers an unreadable file, unparseable JSON, a wrong shape, an entry
  with wrong types, a `version` autopilot does not know, and a `repo` that does
  not match the running config. The store is treated as a cache: losing it is
  never fatal, at startup or mid-run, and the run never dies because of it.
  The `--ignore` command uses this same reader, which is what makes its
  read-append-write rebuild an unreadable file.
  - It is not silent, because unlike the analysis caches this loss has a
    visible consequence: the breaking upgrade is attempted again and lands in
    the next pull request. Autopilot logs one warning line naming the file, so
    the operator knows to re-add the ignores.
  - The warning is logged once per run, not once per read, so a long run does
    not fill the log with it. A read that succeeds after a failed one clears
    that latch.
- Ignores are kept separate from the in-process `skip` set. The restart path
  that calls `skip.clear()` must not clear them.

### Selection

`rankCandidates` gains the ignore set alongside the runtime `skip` set and
returns both the ranked candidates and the rows it dropped because they are
ignored, so the runner can log them. An ignored row is never returned as a
candidate, never upgraded, and never counted as a failure.

### Log output

Once per work cycle, when at least one stored ignore matched a planned row,
autopilot logs a single line to stdout naming what it is ignoring:

```
Ignoring 2 finding(s): web:4c5b6a7 (baz@1.4.2), web:0d1e2f3 (qux@3.0.1)
```

- The module and seven-digit ID are shown in the same `<module>:<id>` form the
  `--ignore` command takes, and the package name and installed version come
  from the plan row so the line says what was skipped and not only a hash.
- Entries are deduplicated per cycle and keep selection order. A cycle that
  matched nothing logs nothing.
- Severity and module are not filtered: this is a report of what the cycle
  passed over, wherever it occurred, which is what makes it useful when a
  cycle publishes nothing at all.

### Debug record

Every successful read of the store writes one debug record through the existing
`src/debug.js`, listing the entries that apply to the running repo: the module,
the ID, and `addedAt`. With the per-selection reload a drain of several
findings would repeat an identical record many times in one cycle, so the
record is written at the first read of each work cycle and again whenever the
effective set changes. The `--ignore` command writes the same record after
storing. Unlike the stdout line above, this lists stored entries whether or not
they matched anything.

### The applied-upgrade list

Autopilot keeps, in memory for the current work branch, an ordered list of what
it has actually applied. One item per upgraded finding:

| Field | Source |
| --- | --- |
| `id` | the finding's full ID, from the upgrade report |
| `severity` | the severity the finding was selected under |
| `kind` | `toolchain`, `runtime` or `package`, from the selection rank |
| `package`, `oldVersion` | from the upgrade report |
| `actions` | from the upgrade report, for the Angular branch/title rules |
| `commits` | the report's ordered `commits[].subject` |

This list is the single source of truth for everything `publish()` decides:

- **Whether to publish at once.** `publishesImmediately` reads the severity and
  kind off the item just added, instead of taking them as separate arguments.
- **Branch and title.** `prPlan()` already works from the reports; it takes the
  list instead, and derives the single-commit versus several-commits case from
  the list's own commit count rather than from a `singleFinding` flag passed
  alongside.
- **Body lines.** One `- <subject> (<7 digits of id>)` line per commit, in list
  order.

The runner already collects upgrade reports into a `reports` array for exactly
this purpose; this makes that array the richer list described above, adds
severity and kind to it, and routes the body through it too.

**Why this replaces `git.subjectsSince()`.** The body is built from the list,
not from `git log`. Autopilot knows what it applied; re-deriving it from the
branch means lining two lists up by position and guessing which commit came
from which finding, and any drift between them would put the *next* finding's
ID on a line. An operator copying that ID into `--ignore` would permanently
ignore an upgrade that was fine while the breaking one came back.

The list is not a weaker record than `git log`. `npm-dep-upgrade` returns the
actual rendered commit subject in `commits[].subject`, guarded at commit time,
so hook-rewritten subjects are already reflected there. A rebase runs before
publishing, but a rebase that applies cleanly preserves subjects, and one that
fails makes autopilot abandon the commits rather than publish them.

`git.subjectsSince()` then has no remaining caller; whether to delete it along
with its tests is left to the builder.

### Pull request body

Titles are unchanged in every case, including single-commit, multi-commit,
Angular toolchain and Angular runtime pull requests.

The only change is that every commit line in the body gains a tail with the
seven-digit finding ID of the upgrade that produced it. Nothing else is added:
the body stays one `- <subject>` line per commit, as today.

```
- deps(web): bump foo from 2.1.0 to 2.4.1 (a1b2c3d)
- deps(web): bump bar from 1.0.3 to 1.2.0 (9f8e7d6)
```

- The seven digits are the first seven characters of the finding's full ID,
  matching what the planner's Markdown report and `npm-dep-upgrade` already
  show, and what `--ignore` takes after the module.
- Several commits of one finding each carry that finding's ID, so two lines
  can share a tail.

Every line comes straight from the applied-upgrade list above, so a line's
subject and its ID always belong to the same item and there is no matching
step, and so no fallback, to get wrong.

### `--clear-cache`

With one store file per clone, clearing is scoped the same way the run is:

- `npm-dep-autopilot --clear-cache` **alone** deletes autopilot's whole cache
  directory, so every clone's ignores go, in addition to running
  `npm-dep-upgrade --clear-cache` as it does today. With no config there is no
  clone to scope to.
- `--clear-cache` **with `--config`** deletes only that clone's
  `ignored-<digest>.json`, then clears the analysis caches as today. The command
  names a clone, so it should not throw away another clone's ignores. This
  happens once at startup, after the single-instance, `gh` login and Git
  identity checks, before the first cycle.
- A deletion that fails is an error, exit 1, consistent with the current
  behaviour for caches that cannot be cleared. A store file that is not there
  is not a failure.
- This is the documented way to un-ignore. There is no way to remove one entry;
  the smallest unit is one clone's whole list.

### Help text

`--ignore <module>:<id>` is longer than the current longest option label, so
every row's description column widens to keep one common alignment column with
at least two spaces after the longest label. The rendered `--help` output must
be inspected after the change, per the repository guide.

## Documentation

- `tools/npm-dep-autopilot/README.md`: the usage block gains the `--ignore`
  form; a new section covers the store location, the forever semantics, the
  prefix matching, the ignore-then-close ordering, and removal through
  `--clear-cache`; the behaviour section describes the ID tails in pull request
  bodies and the per-cycle log line; the exit-code table gains the `--ignore`
  usage errors; the `--clear-cache` paragraph mentions that it also removes
  ignores.
- `AGENTS.md`, the autopilot section: a line on the ignore store and that
  `--clear-cache` removes it.
- The root `README.md` autopilot entry if it summarises the options.

## Versioning

A new capability, so `tools/npm-dep-autopilot` takes a **minor** bump, with
`package.json` and the `package-lock.json` root metadata kept in sync, in a
single final commit after implementation, documentation and verification. No
other tool package changes.

## Verification

- `npm ci --ignore-scripts` and `npm test` in `tools/npm-dep-autopilot`.
- `npm --prefix dev-tooling run lint` from the repository root, zero warnings.
- `npm-dep-autopilot --help` run and its alignment inspected.

Test coverage to add, in the existing files where they fit:

- Argument parsing: the `--ignore` and `--ignore=` forms, repeated use, the
  empty-module `:<id>` form, a missing `--config`, a malformed value, an
  unknown module, and the rejected `--clear-cache` combination.
- The store: atomic write, directory creation, duplicate add, overlapping
  prefixes, missing file, two clones keeping separate files, and each
  unreadable case (bad JSON, wrong shape, bad entry, unknown `version`,
  mismatched `repo`) yielding zero entries with one warning line per run and no
  nonzero exit. Writing over an unreadable file rebuilds it with only the new
  entries.
- Selection: an ignored row never becomes a candidate; prefix matching; module
  scoping; `skip.clear()` on restart leaving ignores in place.
- Runner, with the existing fake `gh` and fake tool commands: an ignore written
  between two cycles of one run is honoured in the second cycle without a
  restart; the per-cycle log line, including a cycle that publishes nothing;
  the published body carries ID tails, including two lines sharing one
  finding's ID.
- The applied-upgrade list: the existing title, branch and publish-immediately
  behaviour is unchanged when driven from the list instead of from the separate
  `singleFinding`/severity arguments, covering the single-commit, several-commit,
  toolchain and runtime cases.
- `--clear-cache` removes the clone's store with `--config`, leaves another
  clone's store alone, and removes the whole directory when run alone.

## Left to the builder

- The exact internal module layout, for example a new `src/ignores.js` next to
  a new `src/cache-clear.js`, and how the loaded set is threaded through the
  runner context.
- The exact shape of an applied-upgrade list item and whether the list is a
  plain array in `workCycle` or a small object owning the derivations, and
  whether `git.subjectsSince()` is deleted now that nothing calls it.
- The exact wording of stdout lines, debug record fields and error messages,
  following the formats already used in the tool.
- The shape of the value `rankCandidates` returns now that it reports dropped
  rows, and how `selectFirst` and `selectDrain` collect them for the per-cycle
  log line.
- Whether the per-selection reload is implemented as a small loader object
  holding the per-run warning latch and the debug-record change detection, or
  as a plain function call with that state held by the runner.
- The commit breakdown, which the implementation plan defines.
