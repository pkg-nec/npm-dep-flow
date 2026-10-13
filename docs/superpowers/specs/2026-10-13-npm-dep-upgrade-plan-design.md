# npm-dep-upgrade-plan design

## Purpose and scope

`npm-dep-upgrade-plan` is a read-only CLI that analyzes vulnerable installed package versions and reports which dependency links can be remediated by each supported remediation strategy. Its first strategy checks whether the vulnerable package itself can move to a newer stable version while satisfying the declared requirement of each direct dependent.

The planner is separate from both `npm-dep-audit` and the future tool that applies dependency changes. It consumes the audit tool's documented JSON CLI output and does not import its private source. A later `npm-dep-upgrade` tool may choose and apply updates; its selection and mutation behavior is outside this design.

This first implementation supports the same target projects as `npm-dep-audit`: ordinary single-package npm projects with `package-lock.json` lockfile versions 2 or 3. Existing audit restrictions for workspaces, local links, shrinkwrap files, and other package managers apply. The planner does not install dependencies, run lifecycle scripts, or change the target project's files.

## Naming and terminology

- Planner command: `npm-dep-upgrade-plan`.
- Future mutation command: `npm-dep-upgrade` (recommended name; not implemented or specified here).
- Ordered resolution methods: **remediation strategies**. A strategy is one way to resolve a vulnerable dependency link. “Profile” is not used because it suggests a bundle of configurable rules.
- First strategy ID: `update-within-declared-range`.

Strategies have an explicit easy-to-hard order. The planner evaluates every registered strategy for every affected dependency link and reports applicable strategies in that order. Version 1 registers only `update-within-declared-range`; it does not add a user-configurable plugin or profile system.

## CLI and tool boundaries

The command is:

```text
npm-dep-upgrade-plan [project] [--format markdown|json]
```

The project directory defaults to the current working directory. Markdown is the default format. The planner requests all findings by invoking the separately installed `npm-dep-audit` CLI with the target project, `--min-severity info`, and `--format json`. It validates the audit JSON schema version 2 before using rows, advisory ranges, and requirement links.

For registry data, the planner invokes `npm view <resolved-package-name> versions --json` from the target project directory. It uses npm's package registry configuration and authentication, and queries each distinct resolved package name once per run even if several vulnerable versions are reported. The returned version list is validated before evaluation. Registry versions are not added to a planner-specific persistent cache in version 1.

The project and registry are only read. The planner does not use `npm install`, does not write a lockfile, and does not ask npm to select or install an update. `npm-dep-audit` and `npm view` remain process boundaries, consistent with the repository's independent CLI tools.

## Inputs and recommendation granularity

Each audit row identifies one exact vulnerable `(package, version)` and contains its highest severity, matching advisories (including each advisory's vulnerable `range`), and requirement groups. Each group contains its verbatim `declaredRequirement` and the direct-dependent links that led to the affected installed copy.

The planner evaluates every direct-dependent link independently. A link is identified by the existing audit fields: resolved dependent `name` and `version`, dependent `location`, vulnerable `targetLocation`, dependency `type`, and `requestedName`. It retains distinct physical links even when package name, version, or requirement text is shared. It must not collapse an exact pin and a range into one package-level yes/no result.

This granularity is required when one vulnerable installed version has multiple incoming requirements. For example, `brace-expansion@5.0.9` may be required as exact `5.0.9` by `nx@23.1.2` and as `^5.0.5` by `minimatch@10.2.5`. The first strategy can report the latter as eligible with a minimum safe compatible version such as `5.0.12`, while reporting the exact-pinned link as ineligible. The output must not imply that the vulnerable version is fully resolved when one of its affected links has no applicable strategy.

## First remediation strategy

The planner obtains the published package versions from the configured npm registry. It considers only strict semantic versions that are stable: prereleases and values that are not semantic versions are excluded. It does not interpret npm dist-tags, Git URLs, tarball URLs, or other non-range specs as version ranges.

For each vulnerable row and each direct-dependent link, `update-within-declared-range` finds the lowest published stable version that satisfies all of these conditions:

1. It is greater than the exact installed vulnerable version.
2. It is outside every vulnerable range listed by the row's advisories.
3. It satisfies that link's declared requirement.

The lowest compatible safe version is shown as evidence that the link can move within its declaration. It is not a selected update instruction; choosing which version to apply belongs to the future mutator. A requirement that does not admit a newer stable safe version, including an exact pin to the installed version, is ineligible for this strategy.

Use the `semver` package for version ordering, range parsing, and range satisfaction. Support normal npm semantic-version requirements, including exact versions, caret, tilde, comparator ranges, and unions. Also support an npm alias requirement when its embedded resolved package name matches the audited package and its embedded version requirement is a valid semantic-version range. A non-range or unsupported requirement is reported as ineligible with an `unsupported-requirement` reason; it does not make the entire report fail. A parseable requirement with no matching version is reported as `no-compatible-safe-version`.

Each direct-dependent link receives one strategy result with the strategy ID and either `eligible` plus `minimumSafeVersion`, or `ineligible` plus a reason. This is a per-link result. The report does not label the whole vulnerable package row as resolved based on only some eligible links.

## Ordering and report formats

Findings sort by severity descending: critical, high, moderate, low, then info if present. npm uses `moderate` for the severity often called “medium.” Within one severity, rows sort by package name and installed version. Requirement groups and links sort deterministically by declared requirement, dependent name and version, then dependent and target locations. Strategy results use their configured easy-to-hard order.

Markdown is the default report. It shows the vulnerable package and installed version, severity, advisories, and each declared requirement with its direct dependent and strategy result. Each link remains separately identifiable by dependent version and location where duplicate installations would otherwise look identical. An eligible result shows the minimum safe compatible version. An ineligible result names the strategy and reason. An empty audit result produces a clear no-findings report.

JSON is a versioned consumer contract with `schemaVersion: 1`, the source `auditedAt`, and `rows`. Each row retains `package`, `version`, `severity`, and advisory data from the audit output. Its `requirements` preserve the audit's declared requirement groups and direct-dependent fields; each direct-dependent record adds an ordered `strategies` array containing the strategy ID, status, and either `minimumSafeVersion` or an ineligibility reason. Rows and links use the ordering above.

## Errors and exit behavior

A completed report exits 0, including when findings exist but no link is eligible. Invalid arguments, a missing or failed `npm-dep-audit` command, malformed or unsupported audit JSON, a failed registry query, or malformed registry output exits nonzero, writes a specific error to stderr, and emits no partial report to stdout. Unsupported dependency requirement syntax is a reported strategy outcome, not a CLI error.

Subprocess invocation must remain portable: invoke commands with argument arrays on Unix-like platforms and use the established Windows `npm.cmd` shell behavior. Do not expose npm credentials or registry configuration in output or errors.

## Architecture and data flow

Keep the new tool as an independent project under `tools/npm-dep-upgrade-plan/`, with its own manifest, lockfile, executable, source, tests, and README. The repository root remains a documentation index rather than an npm workspace.

Separate the implementation into focused units:

- CLI orchestration parses arguments, invokes the adapters, and writes exactly one completed report.
- An audit adapter invokes `npm-dep-audit` and validates its schema version 2 contract.
- A registry adapter invokes `npm view`, validates and normalizes the version list, and deduplicates package queries for one run.
- A strategy evaluator is a pure function over one vulnerable row, one direct-dependent link, the advisory ranges, and the normalized registry versions.
- A strategy registry supplies the stable ID, display label, order, and evaluator for each remediation strategy.
- Report renderers produce Markdown and JSON from the same evaluated data.

The end-to-end flow is: parse and validate CLI input; request the all-severity audit JSON; validate its envelope and rows; collect registry versions for distinct affected package names; evaluate each row's links against every strategy; deterministically sort the completed findings; render the selected format; and write once to stdout. The target project is never modified.

## Verification

The tool's `node:test` suite should cover:

- Stable semantic-version filtering, including prereleases, malformed versions, and deterministic ordering.
- Candidate eligibility across multiple advisory ranges, requiring the candidate to be newer than the installed version, safe against every advisory on the row, and admitted by the exact dependent requirement.
- Exact, caret, tilde, comparator, union, and supported npm alias requirements; exact pins and unsupported non-range specs.
- The `brace-expansion@5.0.9` example, with separate exact and caret links and `5.0.12` as the minimum safe version for the caret link.
- Multiple installed copies, repeated requirement labels, and preservation of dependent/target locations.
- Severity ordering, easy-to-hard strategy ordering, and deterministic Markdown and JSON output.
- One registry query per distinct package name, schema validation, malformed registry data, missing commands, nonzero subprocess exits, Windows command launching, and no partial stdout on errors.
- Empty audit results and successful reports with no eligible strategy.

Do not change `tools/npm-dep-audit/` as part of this implementation. Update the root tool index and add a dedicated README for the new CLI. The future mutator remains a separate project and is not part of this spec or its implementation plan.
