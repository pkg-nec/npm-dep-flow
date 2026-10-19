# npm-dep-upgrade-plan design

## Purpose and scope

`npm-dep-upgrade-plan` is a read-only CLI that analyzes vulnerable installed package versions and reports which physical installations can be remediated by an ordered strategy. Its first strategy checks whether the vulnerable package itself can move to a newer stable version while satisfying every declared requirement that targets the same installation location.

The planner is separate from both `npm-dep-audit` and the future tool that applies dependency changes. It consumes the audit tool's documented JSON CLI output and does not import its private source. A later `npm-dep-upgrade` tool may choose and apply updates; its selection and mutation behavior is outside this design.

This first implementation supports the same target projects as `npm-dep-audit`: ordinary single-package npm projects with `package-lock.json` lockfile versions 2 or 3. Existing audit restrictions for workspaces, local links, shrinkwrap files, and other package managers apply. The planner does not install dependencies, run lifecycle scripts, or change the target project's files.

## Naming and terminology

- Planner command: `npm-dep-upgrade-plan`.
- Future mutation command: `npm-dep-upgrade` (recommended name; not implemented or specified here).
- Ordered resolution methods: **remediation strategies**. A strategy is one way to resolve a vulnerable dependency link. “Profile” is not used because it suggests a bundle of configurable rules.
- First strategy ID: `update-within-declared-range`.

Strategies have an explicit easy-to-hard order. For each target location, the planner selects the first registered strategy that can resolve the finding. Version 1 registers only `update-within-declared-range`; it does not add a user-configurable plugin or profile system.

## CLI and tool boundaries

The command is:

```text
npm-dep-upgrade-plan [project] [--format markdown|json]
```

The project directory defaults to the current working directory. Markdown is the default format. The planner requests all findings by invoking the separately installed `npm-dep-audit` CLI with the target project, `--min-severity info`, and `--format json`. It validates the audit JSON schema version 2 before using rows, advisory ranges, and requirement links.

For registry data, the planner invokes `npm view <resolved-package-name> versions --json` and `npm view <resolved-package-name> time --json` from the target project directory. It uses npm's package registry configuration and authentication, and queries each distinct resolved package name once for versions and once for release times per run even if several vulnerable versions are reported. Stable versions are validated before evaluation; valid release timestamps are normalized to ISO 8601. Missing or invalid time entries produce a null release timestamp. Registry data is not added to a planner-specific persistent cache in version 1.

The project and registry are only read. The planner does not use `npm install`, does not write a lockfile, and does not ask npm to select or install an update. `npm-dep-audit` and `npm view` remain process boundaries, consistent with the repository's independent CLI tools.

## Inputs and recommendation granularity

Each audit row identifies one exact vulnerable `(package, version)` and contains its highest severity, matching advisories (including each advisory's vulnerable `range`), and requirement groups. Each group contains its verbatim `declaredRequirement` and the direct-dependent links that led to the affected installed copy.

The planner emits one row for each distinct `(package, version, targetLocation)` tuple. A `targetLocation` represents one physical package installation and may be referenced by multiple direct-dependent links. The planner groups all declared requirements associated with that target location and evaluates eligibility against the whole group. Different target locations remain separate rows even when package name and version are shared.

This granularity is required when one vulnerable package version is installed in multiple places. For example, one `brace-expansion@5.0.9` target may be pinned to exact `5.0.9` while another target is governed by `^5.0.5`. The first strategy can report the caret target as eligible with a target version such as `5.0.12`, while reporting the exact-pinned target as ineligible. Requirements that point to the same physical target location must all admit a candidate before that row is eligible.

## First remediation strategy

The planner obtains published package versions and release times from the configured npm registry. It considers only strict semantic versions that are stable: prereleases and values that are not semantic versions are excluded. It does not interpret npm dist-tags, Git URLs, tarball URLs, or other non-range specs as version ranges.

For each vulnerable row, `minimumSafeVersion` is the lowest published stable version that satisfies both of these conditions:

1. It is greater than the exact installed vulnerable version.
2. It is outside every vulnerable range listed by the row's advisories.

The corresponding npm release time is reported as `minimumSafeVersionReleasedAt`. It is null when no newer safe version exists or when the registry has no valid timestamp for it. This value is package/version-level and independent of target-location requirements.

For each target location, `update-within-declared-range` reports the lowest newer stable safe version admitted by every declared requirement that points to that location. If no such version exists, the strategy is ineligible. Its target version is not an instruction to apply; choosing which version to use belongs to the future mutator.

Use the `semver` package for version ordering, range parsing, and range satisfaction. Support normal npm semantic-version requirements, including exact versions, caret, tilde, comparator ranges, and unions. Also support an npm alias requirement when its embedded resolved package name matches the audited package and its embedded version requirement is a valid semantic-version range. A non-range, unsupported, or conflicting requirement makes this strategy ineligible for the target location; it does not make the entire report fail.

The row's `status` is `eligible` when an ordered strategy can resolve the vulnerable installation at that target location. `strategy` is the first eligible strategy object, containing `id`, `targetPackage`, `currentVersion`, and `targetVersion`; otherwise status is `ineligible` and `strategy` is null. With the current single strategy, a null `minimumSafeVersion` necessarily makes every row ineligible. Future strategies may resolve a vulnerability by upgrading a direct dependent even when no newer safe version of the vulnerable package exists.

## Ordering and report formats

Findings sort by severity descending: critical, high, moderate, low, then info if present. npm uses `moderate` for the severity often called “medium.” Within one severity, rows sort by package name, installed version, and target location.

Markdown is the default report. It shows one row per target location, the vulnerable package and installed version, **Highest severity** (with the same bold and color formatting as `npm-dep-audit`), minimum safe version and its release time, status, and the selected strategy. An empty audit result produces a clear no-findings report.

JSON is a versioned consumer contract with `schemaVersion: 2`, the source `auditedAt`, and `rows`. Each row contains `package`, `version`, `targetLocation`, `severity`, `minimumSafeVersion`, `minimumSafeVersionReleasedAt`, `status`, and `strategy`. It does not repeat the audit's advisories or requirements. The row identity is the composite `(package, version, targetLocation)`; more than one row may share a package and version.

Human-readable reports begin with one `# npm-dep-upgrade-plan` heading. Empty output retains the heading and the tool-specific no-matches message without an empty table. User-controlled values in Markdown cells and headings escape backslashes, pipes, brackets, emphasis and code markers, and HTML characters. LF, CR, and tab display as visible escapes; other C0 controls and DEL display as `\xNN`. Preserve Unicode and original JSON values.

## Errors and exit behavior

A completed report exits 0, including when no target location is eligible. Invalid arguments, a missing or failed `npm-dep-audit` command, malformed or unsupported audit JSON, a failed registry query, or malformed registry output exits 1, writes a specific error to stderr, and emits no partial report to stdout. Unsupported dependency requirement syntax is a reported strategy outcome, not a CLI error.

A failed audit subprocess reports its command name, exit code, and trimmed stderr when available; otherwise it retains supported-project and PATH guidance. It does not dump child stdout into diagnostics.

Subprocess invocation must remain portable: invoke commands with argument arrays on Unix-like platforms and use the established Windows `npm.cmd` shell behavior. Do not expose npm credentials or registry configuration in output or errors.

## Architecture and data flow

Keep the new tool as an independent project under `tools/npm-dep-upgrade-plan/`, with its own manifest, lockfile, executable, source, tests, and README. The repository root remains a documentation index rather than an npm workspace.

Separate the implementation into focused units:

- CLI orchestration parses arguments, invokes the adapters, and writes exactly one completed report.
- An audit adapter invokes `npm-dep-audit` and validates its schema version 2 contract.
- A registry adapter invokes `npm view`, validates and normalizes version and release-time data, and deduplicates package queries for one run.
- A strategy evaluator is a pure function over one vulnerable row, all declared requirements for one target location, the advisory ranges, and normalized registry versions.
- A strategy registry supplies the stable ID, display label, order, and evaluator for each remediation strategy.
- Report renderers produce Markdown and JSON from the same evaluated data.

The end-to-end flow is: parse and validate CLI input; request the all-severity audit JSON; validate its envelope and rows; collect registry versions and release times for distinct affected package names; compute package/version minimum safe versions; group requirements by target location; select the first eligible strategy for each row; deterministically sort the completed findings; render the selected format; and write once to stdout. The target project is never modified.

## Verification

The tool's `node:test` suite should cover:

- Stable semantic-version filtering, including prereleases, malformed versions, and deterministic ordering; registry release timestamps are normalized or returned as null.
- Minimum safe version selection across multiple advisory ranges, requiring a stable candidate newer than the installed version and safe against every advisory on the row.
- Candidate eligibility per target location, requiring one candidate to satisfy every declared requirement associated with that location.
- Exact, caret, tilde, comparator, union, and supported npm alias requirements; exact pins and unsupported non-range specs.
- The `brace-expansion@5.0.9` example, with separate exact and caret target locations, `5.0.12` as the minimum safe version, a release timestamp, and a nullable strategy object.
- Multiple installed copies, repeated requirement labels, and preservation of dependent/target locations.
- Severity ordering, easy-to-hard strategy selection, and deterministic Markdown and JSON output.
- One registry query per distinct package name, schema validation, malformed registry data, missing commands, nonzero subprocess exits, Windows command launching, and no partial stdout on errors.
- Empty audit results and successful reports with no eligible strategy.

The planner remains independent from the audit implementation. Keep the root tool index and dedicated CLI guide current. The future mutator remains a separate project and is not part of this spec or its implementation plan.
