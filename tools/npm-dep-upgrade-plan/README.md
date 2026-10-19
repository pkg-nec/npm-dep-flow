# npm-dep-upgrade-plan

`npm-dep-upgrade-plan` is a read-only CLI that reports which vulnerable package installations have an eligible remediation strategy. It emits one row for each `(package, installed version, target location)` because each physical installation must be upgraded separately.

The first strategy is `update-within-declared-range`. It checks whether the vulnerable package itself can move to a newer stable version while satisfying every declared requirement that points to the same target location. For example, a vulnerable `brace-expansion@5.0.9` required as exact `5.0.9` by `nx@23.1.2` is ineligible, while a separate installation required as `^5.0.5` by `minimatch@10.2.5` can be eligible with `5.0.12` as the target version. The planner reports a possible update; it does not select or apply it.

## Requirements and installation

- Node.js 20 or newer.
- A supported npm project with `package-lock.json` lockfile version 2 or 3.
- The standalone `npm-dep-paths`, `npm-dep-audit`, and `npm-dep-upgrade-plan` commands on `PATH`.
- npm registry access through the npm registry configuration used by the target project.

`npm-dep-audit` uses `npm-dep-paths` to identify affected dependent links. Install the commands from their independent tool directories:

```sh
cd tools/npm-dep-paths
npm ci --ignore-scripts
npm install --global . --ignore-scripts

cd ../npm-dep-audit
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
npm-dep-upgrade-plan --help
npm-dep-upgrade-plan --version
```

The project path defaults to `.` (the caller’s current directory). Options may appear directly after the command when the project path is omitted, or before or after an explicit project path. Markdown is the default format. `--version` prints the tool version and the absolute directory containing its installed code; `--help` also shows the version. The planner requests all audit severities from `npm-dep-audit`, ordered critical, high, moderate, low, then info. `moderate` is npm's name for the severity commonly called medium.

For local execution, from `tools/npm-dep-upgrade-plan/`, use `node bin/npm-dep-upgrade-plan.js /path/to/project` with the same options. Its audit and paths prerequisites must still be on `PATH`.

## How eligibility is reported

For each vulnerable `(package, installed version)`, the planner asks the configured registry for published versions and release times. It considers only strict stable semantic versions: prereleases, non-semver values, and noncanonical version strings are excluded.

`minimumSafeVersion` is the lowest stable registry version that is newer than the installed version and outside every advisory range for that package/version. It is the same across target locations. Its registry release time is returned as `minimumSafeVersionReleasedAt`; that value is `null` if there is no newer safe version or the registry has no valid timestamp for it.

`status` is evaluated per target location. The current strategy is eligible only when one newer safe version satisfies every declared requirement associated with that location. If no strategy can resolve the finding at that location, `status` is `ineligible` and `strategy` is `null`. When eligible, `strategy` identifies the package and version change that can remediate that location. The planner chooses the first eligible strategy in its configured order.

The planner invokes `npm-dep-audit` and `npm view` as standalone commands. It does not install dependencies, run lifecycle scripts, select an update, write a lockfile, or modify the target project.

## Human-readable report

Markdown starts with the tool name and contains one row per vulnerable installation. The following illustrative fixture has an eligible update:

```markdown
# npm-dep-upgrade-plan

| Package | Installed | Highest severity | Minimum safe version | Released at | Target location | Status | Strategy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| brace-expansion | 5.0.9 | <strong style="color: red">high</strong> | 5.0.12 | 2026-10-01 12:00:00.000 UTC | node\_modules/brace-expansion | eligible | Update within declared range: brace-expansion@5.0.9 → brace-expansion@5.0.12 |
```

An empty report contains the title and `No vulnerable package findings.`, without a table. Highest severity uses the same bold and color styling as audit. Markdown and HTML characters in values display literally, and control characters appear as visible escapes; JSON preserves original strings.

## JSON contract

Use `--format json` for the versioned consumer contract. The composite row identity is `package`, `version`, and `targetLocation`; multiple rows may share a package and version.

```json
{
  "schemaVersion": 2,
  "auditedAt": "2026-10-13T06:00:00.000Z",
  "rows": [
    {
      "package": "brace-expansion",
      "version": "5.0.9",
      "targetLocation": "node_modules/brace-expansion",
      "severity": "high",
      "minimumSafeVersion": "5.0.12",
      "minimumSafeVersionReleasedAt": "2026-10-01T12:00:00.000Z",
      "status": "eligible",
      "strategy": {
        "id": "update-within-declared-range",
        "targetPackage": "brace-expansion",
        "currentVersion": "5.0.9",
        "targetVersion": "5.0.12"
      }
    },
    {
      "package": "brace-expansion",
      "version": "5.0.9",
      "targetLocation": "node_modules/nx/node_modules/brace-expansion",
      "severity": "high",
      "minimumSafeVersion": "5.0.12",
      "minimumSafeVersionReleasedAt": "2026-10-01T12:00:00.000Z",
      "status": "ineligible",
      "strategy": null
    }
  ]
}
```

The JSON report retains the audit timestamp and highest severity, but does not repeat advisory details or declared requirements from `npm-dep-audit`. Markdown uses the **Highest severity** heading and the same bold and color styling as `npm-dep-audit`. An empty audit produces `rows: []` in JSON and a clear no-findings message in Markdown. A completed report exits 0 even when every row is ineligible.

## Supported projects

Supports ordinary single-package npm projects with lockfile versions 2 and 3, matching audit's restrictions. Workspaces, local `file:` or linked dependencies, shrinkwrap files, and other package managers are unsupported.

## Errors and exit codes

Invalid arguments, a missing or failed `npm-dep-audit` command, invalid audit JSON, or a failed or malformed registry response exits 1 and writes an error to stderr. The planner emits no partial report on stdout if any step fails.

A failed audit command's error includes the command name, exit code, and trimmed stderr when available; otherwise it includes supported-project and PATH guidance. Child stdout is not echoed as an error diagnostic.

## Development

From `tools/npm-dep-upgrade-plan/`, run `npm ci --ignore-scripts` and `npm test`. Set `NPM_DEP_AUDIT_INTEGRATION=1` to include the test against the separately installed audit CLI on `PATH`. That integration uses fixture responses for paths and npm, so it needs no live registry and is not a full three-tool end-to-end test.

The [planner design](../../docs/superpowers/specs/2026-10-13-npm-dep-upgrade-plan-design.md) describes eligibility and report contracts.
