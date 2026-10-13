# npm-dep-upgrade-plan

`npm-dep-upgrade-plan` is a read-only CLI that reports which vulnerable installed package versions have a supported remediation strategy. It evaluates each direct-dependent link separately, so two requirements that resolve to the same installed copy can have different results.

The first strategy is `update-within-declared-range`. It checks whether the package itself can move to a newer stable version while still satisfying each dependent's declared requirement. For example, a vulnerable `brace-expansion@5.0.9` required as exact `5.0.9` by `nx@23.1.2` is ineligible for this strategy, while a separate `^5.0.5` requirement from `minimatch@10.2.5` can be eligible with `5.0.12` as the minimum safe compatible version. The planner reports that version as evidence; it does not choose or apply an update.

## Requirements and installation

- Node.js 20 or newer.
- A supported npm project with `package-lock.json` lockfile version 2 or 3.
- The standalone `npm-dep-paths`, `npm-dep-audit`, and `npm-dep-upgrade-plan` commands on `PATH`.
- npm registry access through the npm registry configuration used by the target project.

The input restrictions match `npm-dep-audit`: workspaces, local or linked dependencies, shrinkwrap files, and other package managers are not supported.

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
npm-dep-upgrade-plan /path/to/project
npm-dep-upgrade-plan /path/to/project --format json
npm-dep-upgrade-plan --format json
npm-dep-upgrade-plan --help
```

The project path defaults to the current directory. Markdown is the default format. The planner requests all audit severities from `npm-dep-audit`, ordered critical, high, moderate, low, then info. `moderate` is npm's name for the severity commonly called medium.

## How eligibility is reported

For each vulnerable `(package, installed version)` and each affected direct-dependent link, the planner uses the configured npm registry to list published versions. It considers only strict stable semantic versions: prereleases, non-semver values, and noncanonical version strings are excluded.

The `update-within-declared-range` strategy reports the lowest registry version that is:

1. Newer than the installed vulnerable version.
2. Outside every advisory range for that finding.
3. Allowed by that specific dependent's declared requirement.

Exact versions, caret and tilde ranges, comparator ranges, unions, and matching npm aliases are supported. A non-range requirement or an npm alias for another package is reported as `unsupported-requirement`. If a valid range admits no newer safe version, the result is `no-compatible-safe-version`. These are per-link results; an eligible link does not imply that other links to the same installed package copy are resolved.

The planner invokes `npm-dep-audit` and `npm view` as standalone commands. It does not install dependencies, run lifecycle scripts, select an update, write a lockfile, or modify the target project.

## JSON report

Use `--format json` for the versioned consumer contract:

```json
{
  "schemaVersion": 1,
  "auditedAt": "2026-10-13T06:00:00.000Z",
  "rows": [
    {
      "package": "brace-expansion",
      "version": "5.0.9",
      "severity": "high",
      "advisories": [
        {
          "id": "GHSA-example-1234-abcd",
          "title": "Example vulnerability",
          "url": "https://example.test/advisory",
          "severity": "high",
          "range": "<5.0.12"
        }
      ],
      "requirements": [
        {
          "declaredRequirement": "^5.0.5",
          "directDependents": [
            {
              "name": "minimatch",
              "version": "10.2.5",
              "location": "node_modules/minimatch",
              "targetLocation": "node_modules/brace-expansion",
              "type": "dependencies",
              "requestedName": "brace-expansion",
              "strategies": [
                {
                  "id": "update-within-declared-range",
                  "status": "eligible",
                  "minimumSafeVersion": "5.0.12"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

An empty audit produces `rows: []` in JSON and a clear no-findings message in Markdown. A completed report exits 0 even when every link is ineligible.

## Errors

Invalid arguments, a missing or failed `npm-dep-audit` command, invalid audit JSON, or a failed or malformed registry response exits nonzero and writes an error to stderr. The planner emits no partial report on stdout if any step fails. Unsupported dependency requirements are eligibility results rather than command errors.
