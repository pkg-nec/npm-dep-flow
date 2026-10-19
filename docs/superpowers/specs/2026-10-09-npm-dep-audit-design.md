# npm dependency vulnerability report CLI

## Purpose and scope

Build a command in a larger dependency maintenance workflow. It reports known vulnerabilities for one npm project so a person can review action items and a later scheduling tool can consume the same data. Each vulnerable installed version also shows the requirements declared by its direct dependents, which helps identify whether an update can be made by changing the resolved version or requires changing a dependent. This command performs no installation, dependency update, remediation, or scheduling.

The command accepts an ordinary npm project with `package.json` and `package-lock.json` lockfile version 2 or 3. npm workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers are outside its scope. Detect these cases and return a clear error instead of a potentially incomplete report.

## Repository layout

The CLI is an independent Node.js project under `tools/npm-dep-audit/`. Its `package.json`, `package-lock.json`, `README.md`, `bin/`, `src/`, and `test/` all live there. The repository root contains an index README and shared documents under `docs/`; it has no npm package, lockfile, or workspace. `npm-dep-paths` has its own project under `tools/`; the tools communicate through documented CLI output rather than importing each other's private source files.

Install and test this tool from `tools/npm-dep-audit/` with `npm ci --ignore-scripts` and `npm test`. Install `npm-dep-paths` as a separate CLI and place its executable on `PATH`; this tool executes its documented JSON interface rather than importing its private source. Invoke `node bin/npm-dep-audit.js /path/to/project` from the audit directory, or use the absolute executable path from elsewhere with an explicit target project path.

## Approach

Use the installed npm CLI's `npm audit --json` as the source of vulnerability findings. npm calculates the dependency audit; this tool resolves affected package paths to exact versions in `package-lock.json`, groups and presents the direct advisories, and caches the unfiltered result. For dependency requirements, execute the separately installed `npm-dep-paths` CLI and consume its versioned JSON. It does not depend on Arborist or `npm-audit-report`, and it does not call the registry advisory API itself. Use npm's `semver` package to test advisory ranges against installed versions rather than implementing semver matching.

`npm audit` uses the checked project's virtual dependency tree from its lockfile but also reads that project's root `package.json`. Consequently, both target files are audit inputs and both contribute to the cache fingerprint. The command runs no `npm install` or `npm ci` in the checked project and executes no package lifecycle scripts. Installing this tool's own dependency is a separate setup step in `tools/npm-dep-audit/`.

## Command interface

The command name is `npm-dep-audit`. It takes an optional project directory, defaulting to the current directory, and these options:

- `--format markdown|json`: defaults to `markdown`.
- `--min-severity info|low|moderate|high|critical`: defaults to `info`, which shows all findings.
- `--cache-ttl <duration>`: defaults to `1h`; accepts a positive duration with an explicit unit.
- `--no-cache`: forces a new audit and skips cache reading and writing.

Successful execution exits 0, even when the report contains vulnerabilities. Invalid input, an audit failure, an unusable audit response, or a required `npm-dep-paths` failure exits 1, writes the error to stderr, and does not emit a partial report on stdout. npm's vulnerability exit status is expected; a valid audit JSON document with that status is a successful audit.

## Data flow and report semantics

1. Validate the project and lockfile format. Reject unsupported workspace or local link dependencies.
2. Compute a fingerprint from the exact bytes of the checked project's `package.json` and `package-lock.json`, plus the npm version, effective audit registry, and this tool's cache schema version. Resolve the npm configuration used for the audit from the checked project directory.
3. Read a fresh cache entry if allowed. Otherwise run `npm audit --json` in the project directory with production, development, optional, and peer dependencies explicitly included, regardless of `NODE_ENV` or npm's omit defaults. Validate the report shape before caching it.
4. Read `packages` entries in the lockfile. For each affected node path in npm's vulnerability JSON, resolve the exact package name and version from its lockfile entry. `packages[location].name` takes precedence over deriving a name from the path, to handle aliases.
5. Consider only advisory objects in a vulnerability's `via` list; ignore string entries that represent inherited vulnerability relationships. Match each direct advisory's vulnerable version range against each exact version at the listed node paths. A range must be present and parseable; fail clearly if npm returns an unsupported shape rather than silently omitting a finding.
6. Group matching advisories and all affected lockfile locations by `(package name, exact version)`. Repeated installations of one version produce one row. Different versions produce different rows. Deduplicate advisories within each row by their stable source identifier or URL. Keep affected locations internally to join audit findings to dependency links.
7. Set each row's severity to the highest severity of its matching advisories. Keep rows at or above `--min-severity`, but retain every matching advisory, including lower severity ones, in a kept row. Sort rows by severity descending, then package name and exact version for stable output.
8. For each distinct package name in the kept rows, execute `npm-dep-paths <project> <package-name> --format json` from `PATH` once. A name-only query provides all reachable installed versions in one response. Validate the `npm-dep-paths` schema version 2 envelope, selector, result identities, and requirement/link fields before using it. Match results by exact package name and version.
9. For each audit row, retain only direct-dependent links whose `targetLocation` is one of that row's affected lockfile locations. Remove requirement groups left empty by this filter. Every affected location in a kept row must have at least one qualifying link. A missing version, unmatched affected location, malformed response, unavailable CLI, or nonzero CLI exit fails the entire report with an actionable error and no stdout. A report with no kept rows does not need to invoke `npm-dep-paths`.

The Markdown output is a table with Package, Version, Highest severity, Advisories, and Declared requirements columns. Within each vulnerable-version row, each verbatim declared requirement appears first, followed by its direct dependents. For example, one cell can contain `5.0.9 → nx@23.1.2 [dependencies]` and `^5.0.5 → minimatch@10.2.5 [dependencies]` on separate lines. The display includes each dependent's resolved name and version, dependency type, and alias when present; repeated visible dependent labels may be combined only with an explicit installation count. Distinct requirements remain distinct even when they resolve to the same version. Each advisory displays `(code) title`, with only the GHSA code or fallback advisory ID linked to its source URL. A clean or fully filtered report says that there are no matching direct advisories. Full upstream detail remains an explicit `npm-dep-paths --upstream-of` query and is not expanded in the audit table.

Audit JSON advances from schema version 1 to 2. Its envelope retains `auditedAt` and `rows`. Each row contains `package`, `version`, `severity`, `advisories` (each with `id`, `title`, `url`, `severity`, and `range`), and `requirements` instead of `paths`. `requirements` has the same group and direct-dependent field shapes as `npm-dep-paths` JSON schema version 2: `{ declaredRequirement, directDependents }`, with each dependent carrying `name`, `version`, `location`, `targetLocation`, `type`, and `requestedName`. Audit JSON includes only links to affected locations; it preserves distinct physical links and does not include upstream graphs. Consumers must treat audit schema version 2 as a breaking change from version 1. JSON is the contract for the later scheduling tool; output formatting and severity filtering do not affect the cached raw audit data.

The report deliberately excludes npm's inherited or meta-vulnerability rows. It does not present npm's package-level `fixAvailable` value as a version-specific recommendation, since that value can combine distinct installed versions.

Human-readable reports begin with one `# npm-dep-audit` heading. Empty output retains the heading and the tool-specific no-matches message without an empty table. User-controlled values in Markdown cells and headings escape backslashes, pipes, brackets, emphasis and code markers, and HTML characters. LF, CR, and tab display as visible escapes; other C0 controls and DEL display as `\xNN`. Preserve Unicode and original JSON values.

## Cache behavior

Cache entries live in the user's cache directory outside the checked project and are keyed by canonical project path and the audit fingerprint. The cached value is validated unfiltered audit data with its retrieval time. A hit requires matching inputs and an age strictly below the configured TTL; otherwise run a fresh audit. Write cache files atomically with user-only permissions. Do not cache errors. If a fresh audit fails, return that failure instead of serving an expired entry. Dependency requirements are obtained after severity filtering on each report run, including cache hits; they are not added to the audit cache. The cache does not include credentials.

## Verification

Use fixture-based tests for two vulnerable versions of the same package, duplicate paths to one version, multiple advisories on one version, advisories with different affected ranges, aliases, inherited-only findings, severity filtering and ordering, and both output formats. Test cache hits, expiry, file-content changes, and npm/registry fingerprint changes with a controlled clock and audit runner. Test npm's vulnerability exit code separately from malformed JSON and process failures. Test unsupported lockfiles and workspace/local link inputs. An integration check against a small lockfile project confirms that the real npm JSON shape maps to the expected version rows.

Test the `npm-dep-paths` process boundary with a controlled runner for one invocation per distinct kept package name, version matching, affected-location filtering, distinct requirement groups, duplicate physical links, malformed or incompatible JSON, missing executable, nonzero exit, and no partial stdout. Test Unix-like and Windows command launching with project paths containing spaces and shell-sensitive characters. An integration check installs both CLIs independently, runs the real `npm-dep-paths` executable against a fixture, and confirms the resulting audit Markdown and JSON. Update the repository README, both tool READMEs, and the audit CI workflow to document and verify the separate CLI installation, JSON contract, and `--upstream-of` drill-down workflow.
