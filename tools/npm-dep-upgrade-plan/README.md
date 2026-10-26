# npm-dep-upgrade-plan

`npm-dep-upgrade-plan` is a read-only CLI that reports which vulnerable package installations have an eligible remediation strategy. It emits one row for each `(package, installed version, target location)` because each physical installation must be upgraded separately.

The strategy is `update-within-declared-range`. It groups compatible incoming consumers into upgrade actions. An exact pin can remain on the vulnerable version while a caret consumer moves to a safe version. Four compatible consumers accepting the same safe version form one action, not four findings. The planner is read-only.

## Requirements and installation

- Node.js 20 or newer.
- A supported npm project with `package-lock.json` lockfile version 2 or 3.
- The standalone `npm-dep-paths`, `npm-dep-audit`, `npm-dep-versions`, and `npm-dep-upgrade-plan` commands on `PATH`.
- npm registry access through the npm registry configuration used by the target project.

`npm-dep-audit` uses `npm-dep-paths` to identify affected dependent links. Install the commands from their independent tool directories:

```sh
cd tools/npm-dep-paths
npm ci --ignore-scripts
npm install --global . --ignore-scripts

cd ../npm-dep-audit
npm ci --ignore-scripts
npm install --global . --ignore-scripts

cd ../npm-dep-versions
npm ci --ignore-scripts
npm install --global . --ignore-scripts

cd ../npm-dep-upgrade-plan
npm ci --ignore-scripts
npm install --global . --ignore-scripts
```

Keep npm's global executable directory on `PATH`. Each tool has its own package manifest, dependencies, and CLI.

## Usage

```sh
npm-dep-upgrade-plan
npm-dep-upgrade-plan --format json
npm-dep-upgrade-plan /path/to/project
npm-dep-upgrade-plan /path/to/project --format json
npm-dep-upgrade-plan --cache-ttl 30m
npm-dep-upgrade-plan --no-cache
npm-dep-upgrade-plan /path/to/project --clear-cache
npm-dep-upgrade-plan --clear-cache
npm-dep-upgrade-plan --help
npm-dep-upgrade-plan --version
```

The project path defaults to `.` (the caller’s current directory). Options may appear directly after the command when the project path is omitted, or before or after an explicit project path. Markdown is the default format. `--version` prints the tool version and the absolute directory containing its installed code; `--help` also shows the version. The planner requests all audit severities from `npm-dep-audit`, ordered critical, high, moderate, low, then info. `moderate` is npm's name for the severity commonly called medium.

For local execution, from `tools/npm-dep-upgrade-plan/`, use `node bin/npm-dep-upgrade-plan.js /path/to/project` with the same options. Its audit and paths prerequisites must still be on `PATH`.

## How eligibility is reported

For each distinct vulnerable package, the planner invokes the separately installed `npm-dep-versions` CLI for stable versions and nullable release dates. That tool merges `versions` and `time` from one `npm view <package> versions time --json` command and caches the complete catalog before filtering. It considers only strict stable semantic versions: prereleases, non-semver values, and noncanonical version strings are excluded.

`minimumSafeVersion` is the lowest stable registry version that is newer than the installed version and outside every advisory range for that package/version. It is the same across target locations. Its registry release time is returned as `minimumSafeVersionReleasedAt`; that value is `null` if there is no newer safe version or the registry has no valid timestamp for it.

`resolution` is evaluated per target location:

- `none`: no available action clears a vulnerable consumer branch; `choices` is empty.
- `partial`: available actions clear some branches while incompatible consumers retain vulnerable versions.
- `complete`: the action set clears every affected branch of this installation.

`choices` contains one compatible set of actions to execute together, not alternatives to select between. Each action records its safe target version and original `affectedConsumers` by location, requested name, and declaration type. Splits and multi-action sets are checked together using the selected npm's read-only resolver in a private scratch project. Temporary scoped rules must be removable while retaining valid resolutions. The target project is unchanged, dependencies are not installed, and lifecycle scripts are not run during planning. Existing whole-target single-action checks remain metadata-based; the mutator independently verifies every execution.

Unsupported isolation can produce `none` even when a safe version exists. Registry/resolver failures are errors rather than a no-solution report. Other installations remain separate findings. The installed version may split into safe and vulnerable copies, and npm may change their physical locations.

The planner invokes audit and versions as standalone commands and loads the selected npm's bundled resolver when a split or action combination needs verification. Resolver metadata is revalidated using the effective project npm configuration. Install npm versions compatible with the Node version you run; Node 20 requires a compatible npm such as the tested npm 11 runtime.

## Cache behavior

Structured planner findings are cached for one hour by default under `XDG_CACHE_HOME/npm-dep-upgrade-plan` or `~/.cache/npm-dep-upgrade-plan`, outside the target project by default. A hit skips the audit analysis command and registry version/release-time queries. Markdown and JSON share the same cached findings.

Each invocation first validates the project and checks its canonical directory, exact manifest/lockfile contents, planner/cache version, npm version, effective npm analysis configuration (including scoped registries), and audit/paths/versions tool versions and installed locations. npm configuration is represented only by a digest; configuration values and credentials are not saved in the planner cache. Catalog reuse retains its original `fetchedAt`; refreshing a planner report never extends old registry evidence. Context discovery uses local npm configuration and sibling `--version` calls even on a hit. The installation-only `before` cutoff is excluded: npm 11 can derive a new timestamp from `min-release-age` on every invocation, while the planner reads complete version/release-time metadata. Upgrade independently enforces the current release-age and `before` policies before applying a change.

`--cache-ttl <duration>` accepts a positive integer followed by `s`, `m`, `h`, or `d`, and forwards that lifetime to audit and versions. A cached plan retains its original `auditedAt` and expires no later than that oldest source timestamp (audit or catalog fetch) plus the requested lifetime. Repeated hits do not extend freshness. `--no-cache` bypasses planner reads/writes, forces fresh audit data and forwards bypass through audit to paths and directly to versions. A bypass does not replace existing cached entries. `--clear-cache` deletes the planner's whole cache directory (`XDG_CACHE_HOME/npm-dep-upgrade-plan` or `~/.cache/npm-dep-upgrade-plan`), forwards `--clear-cache` to audit (which forwards it to paths) and to every versions call, then continues normally and writes fresh entries. Without an explicit project argument, `--clear-cache` only clears: the planner runs `npm-dep-audit --clear-cache` and `npm-dep-versions --clear-cache` (both clear-only; audit forwards to paths) and exits 0 without planning. Use it to repair stale entries that `--no-cache` cannot; a directory that cannot be removed, or a failing child, is an error.

Malformed or inaccessible cache entries are misses, and writes replace entries atomically. Cache-storage failure does not prevent a valid report. A failed refresh exits with an error and never serves expired findings.

`npm-dep-upgrade` still invokes this planner and validates the selected ID against its report, which may come from a valid cache. It separately checks the current target, runs uncached audits before mutation and during final verification, and fetches fresh candidate advisories and release-age evidence. Planner caching does not replace those checks. Dependency-file changes after an upgrade invalidate the prior plan even though IDs identify package/location independently of version.

## Human-readable report

Markdown starts with the tool name and contains one row per vulnerable installation. The following illustrative fixture has an eligible update:

```markdown
# npm-dep-upgrade-plan

| ID | Package | Installed | Highest severity | Minimum safe version | Released at | Target location | Resolution | Strategy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ea47178 | brace-expansion | 5.0.9 | <strong style="color: red">high</strong> | 5.0.12 | 2026-10-01 12:00:00.000 UTC | node\_modules/brace-expansion | complete | Update within declared range |
```

An empty report contains the title and `No vulnerable package findings.`, without a table. Highest severity uses the same bold and color styling as audit. Markdown and HTML characters in values display literally, and control characters appear as visible escapes; JSON preserves original strings.

## JSON contract

Planner JSON uses `schemaVersion: 3`, with no compatibility reader or migration for version 2. Audit, paths, and versions retain their own schema version 2 contracts. Update planner and mutator together.

```json
{
  "schemaVersion": 3,
  "auditedAt": "2026-10-23T06:00:00.000Z",
  "rows": [{
    "id": "ea47178ea641751ab935afac50eb277e52a29d6778025d7ce978b0226d5967b1",
    "package": "brace-expansion",
    "version": "5.0.9",
    "targetLocation": "node_modules/brace-expansion",
    "severity": "high",
    "minimumSafeVersion": "5.0.12",
    "minimumSafeVersionReleasedAt": "2026-10-01T12:00:00.000Z",
    "resolution": "partial",
    "choices": [{
      "strategy": "update-within-declared-range",
      "targetPackage": "brace-expansion",
      "targetLocation": "node_modules/brace-expansion",
      "currentVersion": "5.0.9",
      "targetVersion": "5.0.12",
      "affectedConsumers": [{
        "location": "node_modules/minimatch",
        "requestedName": "brace-expansion",
        "type": "dependencies"
      }]
    }]
  }]
}
```

Each ID is the full lowercase SHA-256 of `package + "__" + targetLocation`; Markdown shows seven characters. Version, resolution, and action count do not change this identity. Another installation location gets another ID even for the same package/version.

The old `status` and singular `strategy` fields are removed. No choice IDs, ancestor-search fields, or complete-resolution option groups are emitted. An empty report has `rows: []`; completed reports exit 0, including all-`none` reports. Findings omit full advisory details and declarations, which remain available from audit.

## Supported projects

Supports ordinary single-package npm projects with lockfile versions 2 and 3, matching audit's restrictions. Workspaces, local `file:` or linked dependencies, shrinkwrap files, and other package managers are unsupported.

## Errors and exit codes

Invalid arguments, a missing or failed `npm-dep-audit` or `npm-dep-versions` command, invalid audit JSON, or a failed or malformed registry response exits 1 and writes an error to stderr. The planner emits no partial report on stdout if any step fails.

A failed audit command's error includes the command name, exit code, and trimmed stderr when available; otherwise it includes supported-project and PATH guidance. Child stdout is not echoed as an error diagnostic.

## Development

From `tools/npm-dep-upgrade-plan/`, run `npm ci --ignore-scripts` and `npm test`. Set `NPM_DEP_AUDIT_INTEGRATION=1` to include the test against the separately installed audit and versions CLIs on `PATH`. That integration uses fixture responses for paths and npm, so it needs no live registry; it exercises the real audit and versions CLI boundaries.

The [planner design](../../docs/superpowers/specs/2026-10-13-npm-dep-upgrade-plan-design.md) describes eligibility and report contracts.

## Applying a recommendation

The separate [npm-dep-upgrade](../npm-dep-upgrade/README.md) command reruns this planner and accepts a full item ID or a unique prefix of at least seven hexadecimal characters, optionally with `--package <exact-name>`. It executes all planned actions for one finding per invocation and commits each actual upgrade separately. Partial findings are executable; `none` findings are rejected. IDs do not encode the old version; the current planner report determines eligibility. The mutator independently chooses the newest safe stable release within the original incoming ranges of its selected consumers and the effective age policy, rather than assuming that every version above the minimum is safe.

## Debug logging

Use `--debug` to write external-action diagnostics to stderr while keeping the report on stdout:

```sh
npm-dep-upgrade-plan /path/to/project --debug --format json > report.json 2> debug.log
```

Logs show commands, arguments, working directories, durations and exit outcomes. Debug mode propagates through sibling tools, and their debug records stream to the caller. Cache hits, misses and bypasses explain when analysis is reused; debug mode preserves normal caching.

Credentials in logged arguments and URLs are redacted. Debug records omit environment values, request bodies and subprocess output. Existing error diagnostics and installation progress retain their usual behavior. See the [shared debug guide](../../README.md#debug-logging) for propagation and scope.

Cache identity also hashes active npm configuration source files and referenced environment values, so protected token changes invalidate cached data even though npm redacts those values from configuration output. Only digests are stored. Registry inspection from a workspace member retains npm’s workspace-root configuration; context discovery may query the resolved npm prefix when npm rejects an implicit workspace.
