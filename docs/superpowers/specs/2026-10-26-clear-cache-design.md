# `--clear-cache`: repairing stale analysis caches across the tool chain

Date: 2026-10-26

## Intent and agreed constraints

A stale planner cache entry (produced by older code under an unchanged tool
version) made `npm-dep-upgrade` report a wrong error for a finding ID. Running
`npm-dep-upgrade-plan --no-cache` returned correct data but neither read nor
wrote the cache, so the bad entry stayed and `npm-dep-upgrade` kept using it.
The user needs a way to discard bad cache data from any entry point.

Agreed with the user:

- Keep `--no-cache` unchanged: it bypasses cache reads and writes.
- Add `--clear-cache`: delete the tool's cache, then run normally and write
  fresh entries.
- `--clear-cache` is chained like `--debug`: a tool clears its own cache and
  makes the tools it runs clear theirs.
- Scope is each tool's **whole cache directory**, not only the target
  project's entries.
- Fixing the root cause (cache keys contain tool version strings, not a code
  fingerprint) is out of scope; note it as a possible follow-up.

## Current behavior

- `npm-dep-paths`, `npm-dep-audit`, `npm-dep-versions`, `npm-dep-upgrade-plan`
  each own a cache directory, `$XDG_CACHE_HOME/<tool>` (default
  `~/.cache/<tool>`), written atomically and treated as nonfatal.
  - paths and planner: `result-<hash>.json` per project and query.
  - audit: one file per project, plus a result cache like paths.
  - versions: one catalog entry per project and package.
- `--no-cache` skips reads and writes and is forwarded by planner to audit and
  versions, and by audit to paths.
- `npm-dep-upgrade` has no cache of its own. It runs the planner without
  `--no-cache` (so it consumes planner cache) and runs audit with `--no-cache`.
- `--debug` chains through `NPM_DEP_FLOW_DEBUG=1`.

## Design

### CLI contract

| Tool | `--clear-cache` behavior |
| --- | --- |
| `npm-dep-paths` | Delete its cache directory, then run. |
| `npm-dep-versions` | Delete its cache directory, then run. |
| `npm-dep-audit` | Delete its cache directory, run paths with `--clear-cache`. |
| `npm-dep-upgrade-plan` | Delete its cache directory, run audit and versions with `--clear-cache`. |
| `npm-dep-upgrade` | Own no cache; run planner with `--clear-cache`. |

Help text in each tool documents the flag, with option columns kept aligned.
`--clear-cache` combined with `--no-cache` is accepted: clear first, then run
without reading or writing cache (nothing is repopulated).

### Chaining and ordering

- Chaining uses an explicit `--clear-cache` argument on child commands, not an
  environment variable, because the operation is destructive and should be
  visible in the child command line and in `--debug` logs.
- Each tool clears its cache once per invocation, before any cache read.
- The planner calls audit once and versions once per package; audit calls
  paths. Every child call receives the flag, so versions (and any repeated
  paths call) clear more than once per run. Clearing an empty or missing
  directory is a harmless no-op, but a repeat call after the first child has
  repopulated the cache would discard that fresh entry. This costs only a
  cache miss, so no cross-process de-duplication is added.
- Children are invoked with the flag even when the parent cache directory was
  absent.

### Deletion semantics

- Delete only the tool's own cache directory resolved exactly as the tool
  resolves it for reads/writes (including `XDG_CACHE_HOME` and any injected
  `cacheRoot` in tests). Use recursive, forced removal. Never delete a path
  derived from user input and never touch the target project.
- A missing directory is success.
- Any other deletion error is fatal: exit 1, stderr diagnostic, no partial
  report on stdout. Running on a cache that could not be cleared would
  reproduce the bug.
- Each tool keeps its own small clearing helper next to its cache code; no
  sibling private imports.
- `--debug` logs `cache clear <tool>` without exposing credentials.
- Analysis tools remain non-mutating for target projects; only cache
  directories outside the project change.

### Parsing and validation

- Recognize the flag in each tool's argument parser; it takes no value and may
  appear anywhere among options, like `--no-cache`.
- Unknown-flag and duplicate-flag behavior follows each parser's existing
  conventions.
- `npm-dep-upgrade` forwards the flag only when supplied; configuration-file
  defaults are not added for it.

## Documentation and compatibility

- Update each tool's README and `--help` output. Document that `--no-cache`
  does not repair existing entries and `--clear-cache` does.
- No JSON/Markdown report or schema changes. Existing `--no-cache` behavior and
  contracts are preserved.
- Version bumps (minor, new flag) for all five tools in one final release
  commit relative to the PR base, with `package.json` and lockfile root
  metadata synchronized.

## Testing

- Unit: argument parsing in each tool; clearing helper removes a populated
  cache directory, tolerates a missing one, and fails on a deletion error
  (nonexistent-permission or file-in-place-of-directory fixture).
- Behavior: after a poisoned cache entry, a run with `--clear-cache` returns
  fresh data and the next plain run hits the fresh entry; `--no-cache` still
  leaves the cache untouched.
- Chain: with fake child spawners, planner passes `--clear-cache` to audit and
  every versions call, audit passes it to paths, upgrade passes it to planner;
  none pass it when the flag is absent.
- Failure: a clear error produces exit 1, stderr message, empty stdout.
- Integration/E2E: extend the existing public-CLI integration suites so a real
  chain clears all four caches under an isolated `XDG_CACHE_HOME`.
- `--help` rendered and inspected for alignment; shared lint passes with zero
  warnings; affected tool suites pass on both npm runtimes where applicable.

## Intended commits

1. `feat(paths): add --clear-cache` — flag, clearing helper, tests, docs.
2. `feat(versions): add --clear-cache` — same for versions.
3. `feat(audit): add --clear-cache` — own clearing plus forwarding to paths.
4. `feat(upgrade-plan): add --clear-cache` — own clearing plus forwarding to
   audit and versions.
5. `feat(upgrade): add --clear-cache` — forward to planner.
6. `test: verify cache clearing across the tool chain` — cross-tool
   integration coverage and repository docs.
7. `chore: release --clear-cache` — grouped minor bumps for all five tools.

## Out of scope

- Code fingerprints or content hashes in cache keys.
- Project-scoped clearing, a standalone cache-management command, cache
  statistics, or configuration-file defaults.
- Changing or removing `--no-cache`.
