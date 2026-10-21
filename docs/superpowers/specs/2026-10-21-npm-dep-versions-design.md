# npm-dep-versions and planner integration

## Intent and approved direction

The user frequently inspects package publication dates and wants stable releases by default, an explicit way to include prereleases, semantic version filtering without grep, and caching consistent with the existing analysis tools. They also observed separate planner queries for versions and publication times and want to remove the redundant command launch.

The approved direction is a new standalone `npm-dep-versions` CLI that requests both fields in one npm command, merges the results, owns the catalog cache, and supplies the planner through versioned JSON. It belongs to the existing independent-tool structure; the root remains a non-package and no sibling private source is imported.

Success means one combined npm metadata command per package on a catalog miss, no metadata command on a valid catalog hit, useful interactive filters, and unchanged planner findings for equivalent registry data, including versions without known publication dates.

## Scope and alternatives

Implement the new tool and replace the planner's two direct registry queries with this public CLI boundary. Update installation documentation, CI, lint file coverage, and affected integration/E2E fixtures to include the new command.

Two alternatives were considered: combining queries only inside the planner leaves the user's interactive filtering need unmet; making the new CLI optional while retaining the planner's own registry queries duplicates catalog handling and caching. The integrated CLI is selected.

The upgrade mutator's independent fresh registry and advisory checks remain in place. Routing those checks through this CLI, changing candidate selection, adding dist-tag resolution, and supporting multiple package names per invocation are outside scope. Changes to its test harness and installation instructions are required where they provision the planner's command dependencies.

## CLI contract

```text
npm-dep-versions <package> [options]

--all                         Include prereleases
--major <number>              Restrict to one major version
--range <range>               Restrict to a semantic version range
--project <directory>         npm configuration context (default: caller's cwd)
--format markdown|json        Output format (default: markdown)
--cache-ttl <duration>         Cache lifetime (default: 1h)
--no-cache                    Bypass cache reads and writes
--debug                       Log external actions and cache decisions to stderr
--version                     Show tool version and installed directory
--help                        Show usage
```

Accept exactly one canonical package name, including scoped names. Reject package specs containing a version, tag, range, URL, or shell syntax before spawning npm. Do not require a manifest, lockfile, or installed dependencies in the selected context directory: this is also a standalone registry inspection command. Resolve and validate the existing context directory, and run npm there so project and user npm configuration apply naturally. Never modify its files.

Options taking values must occur at most once; reject missing values, unknown flags, and extra positional arguments. `--all`, `--no-cache`, and `--debug` are idempotent. `--major` accepts a nonnegative safe integer written as `0` or a decimal integer without leading zeroes. `--range` must be a nonempty valid semver range; quote it in shell examples. If both filters are supplied, intersect them. TTL accepts a positive safe duration expressed as an integer and `s`, `m`, `h`, or `d`, matching the analysis tools. Help and version require no package, npm command, or cache lookup.

Examples:

```sh
npm-dep-versions react
npm-dep-versions react --all
npm-dep-versions react --major 19
npm-dep-versions react --range '>=18 <20'
npm-dep-versions @scope/pkg --project /path/to/project --format json
```

Stable means a strict canonical semantic version with no prerelease component; build metadata is allowed. It makes no security or deprecation claim. Invalid and noncanonical version strings are excluded in all modes. `--all` includes valid prereleases but does not disable the major or range filters. Use `semver.satisfies` with `includePrerelease: true` when `--all` is present, and the normal stable semantics otherwise. Thus `--all --range '>=19 <20'` includes prereleases satisfying those actual bounds; a prerelease below the lower bound is still excluded.

Sort rows by semantic version ascending, breaking equal-precedence build metadata ties by exact string comparison. Deduplicate exact version strings. No configurable sorting or date filters are needed for this release.

## Registry query and normalization

On a miss or bypass, invoke exactly:

```sh
npm view <package> versions time --json
```

Use npm's effective registry selection and authentication. One combined command supplies both fields from one metadata query flow. Do not run separate fallback `versions` and `time` commands. This reduces process launches; it does not promise a fixed number of internal npm HTTP requests.

Normalize the npm 11 object envelope and npm 12 singleton-array envelope into one catalog. Account for npm's field-unwrapping behavior when a requested field is absent: a versions-only string/list response is accepted with unknown dates. Exercise supported shapes with the actual pinned npm 11/12 runtimes against a fixture registry before finalizing the parser.

The `versions` list is authoritative for membership, including when a time entry is absent. Accept a scalar version string or an array of strings for this field; reject malformed field types and responses from which a version list cannot be obtained unambiguously. An explicitly empty version list is valid. Normalize missing or null `time` to an empty map; a present non-null value must be an object rather than an array or scalar. A malformed combined response fails without a second metadata command.

Merge each valid version from `versions` with its corresponding `time` entry. Ignore timestamp-only entries and metadata keys such as `created` and `modified`. Missing or invalid individual dates become `releasedAt: null`; they do not remove the version. Validate real calendar dates and offsets before normalizing timestamps to UTC ISO 8601. Keep prereleases in the normalized cached catalog and filter them afterward.

## Output contract

The initial public JSON contract uses schema version 2, consistent with this repository:

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

`rows` contains the filtered, deterministically sorted view. `fetchedAt` records the start of the successful combined npm query and remains unchanged on cache hits. A cached catalog is independent of output format and filters. Return no cache paths, credentials, or effective npm configuration in the report.

Markdown begins with `# npm-dep-versions`, identifies the package and original fetch timestamp, and renders Version and Released at columns. Show unknown dates as an em dash and known dates as UTC. Empty results have a clear no-matching-versions message without a table. Follow the established escaping rules for Markdown and control characters. JSON preserves original accepted version strings and normalized dates.

Completed reports exit 0 even with no matching rows. Invalid input, missing npm, a failed command, malformed registry output, or failed context discovery exits 1 with a useful stderr diagnostic and no partial stdout. Cache-storage failures are nonfatal. Do not expose raw registry response bodies, configuration, or credential-bearing stderr. Debug logging follows existing redaction, subprocess timing, stderr, and cache hit/miss/bypass conventions.

## Catalog cache

Store catalogs under `XDG_CACHE_HOME/npm-dep-versions` or `~/.cache/npm-dep-versions`, outside the selected context directory by default. Cache all normalized valid versions and their nullable release times before applying filters. Markdown, JSON, stable-only, prerelease, major, and range queries reuse the same entry.

Identity includes the tool/cache version, exact package name, canonical context directory, npm version, and a digest of sorted effective npm configuration. Never store configuration values or credentials. As in the planner, omit npm's installation-only moving `before` cutoff from the digest; registry catalogs are not installation selections. Directory isolation is intentional even if two directories have identical configuration. Manifest and lockfile bytes are not catalog inputs; changes affecting effective npm configuration are captured through context discovery. Discover npm context on each cached invocation before considering a hit.

Freshness is measured from the original `fetchedAt`, using the current invocation's TTL. Reject future timestamps, expired entries, invalid envelopes/rows, wrong identity, and checksum mismatches. Hits do not extend freshness. `--no-cache` skips catalog reads and writes and performs the combined npm query; no context-discovery command is required solely to build a bypassed cache identity. Use private file/directory modes and unique temporary files with atomic replacement and cleanup, following existing caches. Malformed/unavailable cache storage is a miss, and a failed refresh must not serve expired data.

## Planner boundary and freshness

The planner calls the separately installed command once per distinct audited package, with the target project as cwd:

```sh
npm-dep-versions <package> --format json --cache-ttl <duration>
```

Use default stable-only results and no range or major filters. Forward the planner's TTL, `--no-cache`, and debug mode. Add `npm-dep-versions --version` (including its installed location) to planner result-cache identity alongside the existing npm, audit, and paths context. A valid planner result hit skips the catalog command but still performs its documented local context discovery.

Validate schema version, exact requested package, fetch timestamp, rows, canonical stable versions, unique version strings, and canonical nullable release timestamps before evaluation. Reject a fetchedAt in the future or a catalog already as old as the requested TTL. Normalize ordering in the adapter and build the evaluator's existing version list and release-time map. Missing-command diagnostics name the required standalone CLI. No sibling private modules are imported, and the planner no longer launches direct npm metadata queries.

Planner result freshness must account for both audit and catalog sources. Set its source freshness to the earliest of audit `auditedAt` and every catalog `fetchedAt`. Its expiration is no later than that earliest timestamp plus the requested TTL and any existing upstream expiry. With no audited packages, only audit freshness applies. This prevents a new planner result from extending the lifetime of an old catalog. Planner report fields and schema version 2 remain unchanged; `auditedAt` retains the source audit timestamp.

The mutator still runs its independent fresh registry/advisory checks and enforces release age. The new cache does not authorize a mutation or replace fresh security evidence.

## Implementation boundaries and repository integration

Create an independent `tools/npm-dep-versions/` package with its own executable, manifest, lockfile, source, tests, and README, supporting Node.js 20 or newer. Separate argument validation, npm context discovery, subprocess execution, registry normalization, cache handling, filtering, output rendering, and orchestration into focused units. Use semver as a direct dependency.

Replace the planner registry adapter with a public versions-CLI adapter, update orchestration/cache context/freshness, and retain the pure strategy evaluator. Update debug and integration fixtures at the command boundary. Do not create a shared runtime package or import another tool's private files.

Extend shared ESLint file coverage without changing recommended rules. Add CI for the new tool, wire its installation into planner integration and upgrade E2E jobs, and update relevant command shims and fixture registry responses. Document installation order, CLI examples, filters, the merged nullable dates, caching, nested bypass/TTL, and fresh mutator checks in root and affected tool guides. Update AGENTS.md and CONTRIBUTING.md where their tool inventory, boundaries, or verification instructions change.

Initialize the new tool at `0.1.0`. The planner gains a new required runtime command and advances from `0.5.0` to `0.6.0`; document the installation requirement explicitly. Keep package manifests and lockfile root versions synchronized, with release metadata together in the final planned commit. Test-harness/documentation-only updates to the mutator do not require a runtime package bump.

Use `/home/maw/src/nrc/npm-dep-flow-impl/tmp` for all temporary files and test scratch data, including environment-directed test roots. New worktrees belong under `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`. The implementation plan must list intended commits before coding, including the final release metadata commit.

## Verification and acceptance

Use focused tests that exercise behavior and command contracts:

- One combined npm command on a catalog miss, hit without metadata lookup, and bypass without reads/writes; scoped names and context directories with spaces; Unix argument arrays and safe Windows command shims.
- npm 11/12 combined output compatibility, absent time with field unwrapping, empty lists, malformed envelopes, timestamp-only entries, duplicate/noncanonical versions, build metadata, invalid calendar dates, and nullable timestamps.
- Stable default, --all, major zero and other majors, quoted ranges, combined filter intersection, prerelease range bounds, deterministic order, and invalid arguments.
- Versioned JSON, escaped Markdown, empty reports, original fetchedAt preservation, safe stderr/debug behavior, missing commands, and no partial stdout on errors.
- Catalog reuse across formats and filters; TTL boundaries and shorter caller TTLs; config/context/package/tool identity changes; corrupt/unreadable caches, atomic replacement, nonfatal write failures, and no stale fallback.
- Planner CLI invocation once per package, required-command errors, boundary validation, unchanged strategies/JSON/findings with nullable dates, nested TTL/bypass/debug propagation, catalog-aware result expiry, and new sibling version/location invalidation.
- Real new-CLI-to-fixture-registry checks with supported npm 11/12; planner integration through the real new CLI; upgrade E2E provisioning includes the new dependency and retains independent fresh security checks.

Run each affected tool suite and required integration checks, upgrade E2E for the affected command chain, and shared lint with zero warnings. Render and inspect changed --help output for coverage and common-column alignment. A written implementation plan and its execution-method selection follow user review of this spec.
