# npm-dep-upgrade-plan

`npm-dep-upgrade-plan` is a read-only CLI that reports which vulnerable package installations have an eligible remediation strategy. It emits one row for each `(package, installed version, target location)` because each physical installation must be upgraded separately.

The strategy is `update-within-declared-range`. It groups compatible incoming consumers into upgrade actions. An exact pin can remain on the vulnerable version while a caret consumer moves to a safe version. Four compatible consumers accepting the same safe version form one action, not four findings. The planner is read-only.

When consumers remain that no within-range action can cover, the planner also searches up to two ancestor levels for a parent release that clears the branch (strategy `upgrade-via-parent-dependency`). The Strategy cell then shows the within-range label once, followed by each parent transition, for example `Upgrade via parent dependency: B@1.0.1 → B@1.1.0`. Parent choices use the same schema 3 fields as other choices: `targetPackage`, `targetLocation`, `currentVersion` and `targetVersion` describe the ancestor, and `affectedConsumers` lists the finding's branches the upgrade clears. See [Parent upgrades](#parent-upgrades-schema-decision).

Branches that none of those strategies covers can finally be handled by an Angular line strategy: `upgrade-angular-toolchain` (label `Upgrade Angular toolchain`) bumps the exact-pinned Angular CLI toolchain as one unit, and `upgrade-angular-runtime` (label `Upgrade Angular runtime`) does the same for the Angular runtime packages. See [Angular lines](#angular-lines).

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

## Parent upgrades

Consumers that no within-range action can cover (an exact pin, for example) are searched through their ancestors, breadth first, at most two levels above the vulnerable installation: the immediate parent first, then its parents. The project root is never an upgradable package. A branch stops climbing as soon as one level has a suitable release, so a newer grandparent is not even looked up once the immediate parent clears the branch. Other unresolved branches are searched independently, and several branches that one ancestor release frees become one deduplicated action. The depth is an internal constant; there is no flag and the report contains no search status or rejected-candidate list.

A release is a candidate when it is a newer stable version that satisfies **every** incoming declaration on that ancestor installation (including declarations from consumers outside the branch, aliases and peer requirements) was published no later than the release-age cutoff from npm configuration: `min-release-age`, never fewer than seven days, bounded by an explicit `before` (releases without a publication time cannot be pinned and are skipped; the executor re-checks the same policy and fresh advisories). The lowest suitable candidate wins. Suitability is then decided by the resolver on the resolved closure: the release is used only if the consumer branch no longer reaches an affected installation. Removing the dependency clears a branch; a descendant that brings the affected version back, or replacing it with another affected version, does not. Another route to the original vulnerable installation keeps a branch uncleared, while an affected installation the consumer already reached through an unrelated route is a separate finding.

Parent upgrades never add overrides and never edit declarations or the lockfile by hand. The resolver works in two steps. First it applies npm's named update to the ancestor under the project's own declarations, capped at the tested release's publication time so the ancestor lands on exactly that version. That cap would also hold back everything the release brings in, so the second step removes those new or changed installations from the tree and lets npm resolve them again under the real release-age cutoff, which yields the newest releases that are old enough while every other installation (including another copy of the same package elsewhere) stays untouched. A candidate that would also move another copy of the ancestor, or any installation outside the ancestor's resolved closure, is rejected. The action set is resolved together with within-range actions, parents first. Because npm can dedupe the shared installation upward when a parent pins a safe version, an action that an earlier parent already satisfied stays in the plan and is skipped by the executor only if it is still satisfied at execution time.

An ancestor release can also loosen what it asks of the vulnerable package, for example by turning an exact pin into a caret that accepts a safe version while the locked vulnerable one still satisfies it. The planner therefore resolves each candidate ancestor and, for branches that remain, reads the declaration the resolved graph now carries and adds a within-range action for them. The ancestor is suitable if the pair clears the branch. The Strategy cell then shows both, for example `Update within declared range; Upgrade via parent dependency: mocha@10.0.0 → mocha@10.6.0`, and both choices list the same branch in `affectedConsumers` (one ancestor action and one follow-up within-range action may share a branch, never two actions of one strategy).

Parent discovery queries `npm-dep-paths <target> --upstream-of <parent>` once per distinct immediate parent (one answer carries every ancestor) and reuses the `npm-dep-versions` catalogs, each fetched at most once per run. `--no-cache` and `--clear-cache` are forwarded to the paths calls like to audit and versions (paths results depend only on the lockfile, so `--cache-ttl` applies to the catalogs only), and cached plans expire no later than the oldest catalog or audit source. Malformed or failed paths, catalog or resolver results are errors, not evidence that no solution exists.

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

## Angular lines

Projects that pin Angular packages to exact versions cannot be fixed by a within-range update, and the parent strategy never upgrades the project root. Two strategies treat a coordinated group of root-declared packages, a line, as one unit: the toolchain and the runtime. The strategies are evaluated in the order within-range, parent, toolchain, runtime. Each covers only the consumer branches the earlier ones left uncovered. Other strategies' choices stay in the same finding and the action set is resolved together. A finding carries at most one choice per line.

A line strategy applies only when all of these hold:

- The line's anchor is a direct dependency of the project root. Every other member of the line is a member only when the root declares it; a declared member must be installed.
- All members share the anchor's installed version; otherwise the strategy does not apply.
- The vulnerable installation is a member or at most two levels below one (taken from the same `npm-dep-paths --upstream-of` answer used for parent upgrades).

Candidates come from the `npm-dep-versions` catalog of the line's anchor: stable releases newer than the installed one within the same major. The lowest candidate that wins is the one for which the read-only resolver keeps every existing action, including a choice of the other line, and clears at least one uncovered in-scope branch. A major bump is never proposed. The planner applies no release-age filter, like the other strategies; `npm-dep-upgrade` enforces the seven-day rule when it executes. Cache identity, TTL and freshness follow the parent strategy: a cached plan expires no later than the oldest catalog or audit source. Planner JSON stays at `schemaVersion: 3`, since the new strategy values are additive; install the planner and `npm-dep-upgrade` releases together.

The resolver sets every member the root declares for the chosen line to the exact target version, in the field that declares it, in a private scratch project. The line's override entries are updated too, but only if they exist, and the closures of those members are in scope. Members of the other line are not touched. Before resolving, the scratch resolver detaches the line's root member installations from the starting tree and lets npm place them again from the rewritten declarations, because npm can otherwise refuse (ERESOLVE) to replace members that peer on each other exactly while a dependent outside the line still holds the old versions. The executor's real install can still differ from this scratch resolution; in that case its own verification fails safe and nothing is committed.

In the Strategy cell the choices appear after any within-range text, then parent transitions, then the toolchain transition, then the runtime transition. In JSON a choice uses the usual schema 3 fields, with `targetPackage` naming the anchor, `targetLocation` its installation and `affectedConsumers` the branches cleared.

### Angular toolchain

Strategy `upgrade-angular-toolchain`, label `Upgrade Angular toolchain`. The anchor is `@angular/cli`; `@angular/build` is also a member when the root declares it. The `@angular-devkit/core` entry in `overrides` is updated too, if present. The runtime packages (`@angular/core` and friends) are not part of the toolchain.

The Strategy cell shows the choice as `Upgrade Angular toolchain: @angular/cli@X → @angular/cli@Y`:

```json
{
  "strategy": "upgrade-angular-toolchain",
  "targetPackage": "@angular/cli",
  "targetLocation": "node_modules/@angular/cli",
  "currentVersion": "20.3.1",
  "targetVersion": "20.3.4",
  "affectedConsumers": [
    { "location": "node_modules/@angular/cli", "requestedName": "@angular-devkit/schematics", "type": "dependencies" }
  ]
}
```

### Angular runtime

Strategy `upgrade-angular-runtime`, label `Upgrade Angular runtime`. The members are `@angular/common`, `@angular/compiler`, `@angular/compiler-cli`, `@angular/core`, `@angular/forms`, `@angular/platform-browser` and `@angular/router`, each only when the root declares it. `@angular/core` is required (it is the anchor, so its catalog, release time and `nx migrate` argument are used) and all declared members must be installed at one shared version. The `@angular/platform-browser-dynamic` entry in `overrides`, as a string or in object form (`.`), is updated to the target only if it exists; it is never added. The toolchain packages are not part of the runtime line.

The Strategy cell shows the choice as `Upgrade Angular runtime: @angular/core@X → @angular/core@Y`. For example, in JSON:

```json
{
  "strategy": "upgrade-angular-runtime",
  "targetPackage": "@angular/core",
  "targetLocation": "node_modules/@angular/core",
  "currentVersion": "21.2.25",
  "targetVersion": "21.2.26",
  "affectedConsumers": [
    { "location": "", "requestedName": "@angular/core", "type": "dependencies" }
  ]
}
```

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

## Parent upgrades: schema decision

Planner JSON keeps `schemaVersion: 3`. The parent strategy needs no field that choices lack: the existing target fields describe the ancestor and `affectedConsumers` already identifies the covered branches of the original finding. The ancestor level is recomputed from fresh graph data by the executor and is not part of the contract. The finding ID, `resolution` meanings and one-row-per-installation rule are unchanged. The mutator validates parent choices by strategy; they do not have to match the vulnerable package or location.
