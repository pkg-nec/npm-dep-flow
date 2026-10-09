# npm dependency vulnerability report CLI

## Purpose and scope

Build the first standalone command in a larger dependency maintenance workflow. It reports known vulnerabilities for one npm project so a person can review action items and a later scheduling tool can consume the same data. This command performs no installation, dependency update, remediation, or scheduling.

The first version accepts an ordinary npm project with `package.json` and `package-lock.json` lockfile version 2 or 3. npm workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers are outside this version's scope. Detect these cases and return a clear error instead of a potentially incomplete report.

## Repository layout

The CLI is an independent Node.js project under `tools/npm-dep-audit/`. Its `package.json`, `package-lock.json`, `README.md`, `bin/`, `src/`, and `test/` all live there. The repository root contains an index README and shared documents under `docs/`; it has no npm package, lockfile, or workspace. A future tool gets its own `tools/<name>/` project and communicates through documented CLI output rather than importing this tool's private source files.

Install and test this tool from `tools/npm-dep-audit/` with `npm ci --ignore-scripts` and `npm test`. Invoke `node bin/npm-dep-audit.js /path/to/project` from that directory, or use the absolute executable path from elsewhere with an explicit target project path.

## Approach

Use the installed npm CLI's `npm audit --json` as the source of vulnerability findings. npm calculates the dependency audit; this tool resolves affected package paths to exact versions in `package-lock.json`, groups and presents the direct advisories, and caches the unfiltered result. It does not depend on Arborist or `npm-audit-report`, and it does not call the registry advisory API itself. Use npm's `semver` package to test advisory ranges against installed versions rather than implementing semver matching.

`npm audit` uses the checked project's virtual dependency tree from its lockfile but also reads that project's root `package.json`. Consequently, both target files are audit inputs and both contribute to the cache fingerprint. The command runs no `npm install` or `npm ci` in the checked project and executes no package lifecycle scripts. Installing this tool's own dependency is a separate setup step in `tools/npm-dep-audit/`.

## Command interface

The command name is `npm-dep-audit`. It takes an optional project directory, defaulting to the current directory, and these options:

- `--format markdown|json`: defaults to `markdown`.
- `--min-severity info|low|moderate|high|critical`: defaults to `info`, which shows all findings.
- `--cache-ttl <duration>`: defaults to `1h`; accepts a positive duration with an explicit unit.
- `--no-cache`: forces a new audit and skips cache reading and writing.

Successful execution exits 0, even when the report contains vulnerabilities. Invalid input, an audit failure, or an unusable audit response exits nonzero, writes the error to stderr, and does not emit a partial report on stdout. npm's vulnerability exit status is expected; a valid audit JSON document with that status is a successful audit.

## Data flow and report semantics

1. Validate the project and lockfile format. Reject unsupported workspace or local link dependencies.
2. Compute a fingerprint from the exact bytes of the checked project's `package.json` and `package-lock.json`, plus the npm version, effective audit registry, and this tool's cache schema version. Resolve the npm configuration used for the audit from the checked project directory.
3. Read a fresh cache entry if allowed. Otherwise run `npm audit --json` in the project directory with production, development, optional, and peer dependencies explicitly included, regardless of `NODE_ENV` or npm's omit defaults. Validate the report shape before caching it.
4. Read `packages` entries in the lockfile. For each affected node path in npm's vulnerability JSON, resolve the exact package name and version from its lockfile entry. `packages[location].name` takes precedence over deriving a name from the path, to handle aliases.
5. Consider only advisory objects in a vulnerability's `via` list; ignore string entries that represent inherited vulnerability relationships. Match each direct advisory's vulnerable version range against each exact version at the listed node paths. A range must be present and parseable; fail clearly if npm returns an unsupported shape rather than silently omitting a finding.
6. Group matching advisories and all affected paths by `(package name, exact version)`. Repeated installations of one version produce one row. Different versions produce different rows. Deduplicate advisories within each row by their stable source identifier or URL.
7. Set each row's severity to the highest severity of its matching advisories. Keep rows at or above `--min-severity`, but retain every matching advisory, including lower severity ones, in a kept row. Sort rows by severity descending, then package name and exact version for stable output.

The Markdown output is a table with Package, Version, Highest severity, Advisories, and Installed paths columns. Advisory titles link to their source URLs; paths are sorted and shown within their row. A clean or fully filtered report says that there are no matching direct advisories.

JSON is a documented object with `schemaVersion`, `auditedAt`, and `rows`. Each row contains `package`, `version`, `severity`, `advisories` (each with `id`, `title`, `url`, `severity`, and `range`), and `paths`. JSON is the contract for the later scheduling tool; output formatting and severity filtering do not affect the cached audit data.

The report deliberately excludes npm's inherited or meta-vulnerability rows. It does not present npm's package-level `fixAvailable` value as a version-specific recommendation, since that value can combine distinct installed versions.

## Cache behavior

Cache entries live in the user's cache directory outside the checked project and are keyed by canonical project path and the audit fingerprint. The cached value is validated unfiltered audit data with its retrieval time. A hit requires matching inputs and an age strictly below the configured TTL; otherwise run a fresh audit. Write cache files atomically with user-only permissions. Do not cache errors. If a fresh audit fails, return that failure instead of serving an expired entry. The cache does not include credentials.

## Verification

Use fixture-based tests for two vulnerable versions of the same package, duplicate paths to one version, multiple advisories on one version, advisories with different affected ranges, aliases, inherited-only findings, severity filtering and ordering, and both output formats. Test cache hits, expiry, file-content changes, and npm/registry fingerprint changes with a controlled clock and audit runner. Test npm's vulnerability exit code separately from malformed JSON and process failures. Test unsupported lockfiles and workspace/local link inputs. An integration check against a small lockfile project confirms that the real npm JSON shape maps to the expected version rows.
