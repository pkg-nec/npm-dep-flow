# npm-dep-versions

Inspect package versions and publication dates using your npm registry configuration.
Requires Node.js 20+ and npm on PATH. Install independently with `npm install --global . --ignore-scripts` from this tool directory.

```sh
npm-dep-versions react
npm-dep-versions react --all
npm-dep-versions react --major 19
npm-dep-versions react --range '>=18 <20'
npm-dep-versions @scope/pkg --project /path/to/app --format json
```

Stable releases are the default; `--all` includes prereleases. `--major` and `--range` intersect when combined. Quote range expressions in your shell. With `--all`, range matching includes prereleases within the actual semantic version bounds. Stable does not mean vulnerability-free or nondeprecated.

The tool fetches `versions` and `time` in one `npm view` command, retains versions with unknown dates, ignores time-only entries, and sorts by semantic version ascending. `--project` selects the directory whose npm configuration applies; it defaults to the current directory and requires no manifest or lockfile. The selected directory is never modified.

Markdown is the default. `--format json` returns schema version 2 with `package`, original `fetchedAt`, and `rows` containing `version` and nullable UTC `releasedAt`. Empty results exit 0. Errors exit 1 with a stderr diagnostic and no partial stdout. Use `--help` for all options; `--debug` logs external actions to stderr.

## Catalog cache

The full catalog, including prereleases, is cached before filtering for one hour by default under `XDG_CACHE_HOME/npm-dep-versions` or `~/.cache/npm-dep-versions`. Formats and filters share the same data. `--cache-ttl 30m` selects a positive duration in seconds (`s`), minutes (`m`), hours (`h`), or days (`d`); freshness always starts at the original fetch time. `--no-cache` bypasses both reads and writes without replacing previous entries. `--clear-cache` deletes the whole cache directory above and then runs normally, repairing entries that `--no-cache` leaves in place; a directory that cannot be removed is an error.

Cache identity includes package name, canonical context directory, npm version, tool version and a digest of effective npm configuration, including scoped registries. The installation-only moving `before` cutoff is excluded. Configuration values and credentials are not stored. Local npm context queries still run on cache hits. Invalid/unavailable cache entries are misses; storage failures are nonfatal, and failed refreshes never serve expired data.

With `--all`, semver interprets shorthand `>=19` as including `19.0.0` prereleases; use `--range '>=19.0.0 <20'` to set a stable lower bound explicitly.

## JSON example

```json
{
  "schemaVersion": 2,
  "package": "example-package",
  "fetchedAt": "2026-10-21T03:00:00.000Z",
  "rows": [
    { "version": "1.0.0", "releasedAt": "2026-10-01T12:00:00.000Z" },
    { "version": "1.1.0", "releasedAt": null }
  ]
}
```

## Development and integration

Run `npm ci --ignore-scripts` and `npm test` in this directory. Provide `NPM_DEP_UPGRADE_E2E_NPM_CLI` (npm 12.1.0) and `NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI` (npm 11.10.0) as absolute `npm-cli.js` paths for the real registry compatibility tests; these tests use only a local fixture registry. Without configured runtime entries those cases are skipped. CI requires npm12 on Windows and both runtimes on Linux with `NPM_DEP_VERSIONS_REQUIRE_RUNTIMES=1`.

`npm-dep-upgrade-plan` requires this CLI separately on PATH. It forwards TTL, bypass and debug controls; its result expires no later than the oldest audit or catalog source timestamp plus TTL. Install tools in order: paths, audit, versions, planner, upgrade. Upgrade still performs independent fresh candidate metadata and advisory checks before applying changes.

Cache identity also hashes active npm configuration source files and referenced environment values, so protected token changes invalidate cached data even though npm redacts those values from configuration output. Only digests are stored. Registry inspection from a workspace member retains npm’s workspace-root configuration; context discovery may query the resolved npm prefix when npm rejects an implicit workspace.
