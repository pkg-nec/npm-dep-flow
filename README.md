# npm-dep-flow

Small command-line tools for maintaining Node.js project dependencies.

Each tool is an independent Node.js project under `tools/`, with its own package manifest, lockfile, dependencies, executable, tests, and usage guide. The repository root is for shared documentation; it is not an npm package or workspace. Tools can exchange data through their documented command-line interfaces, including versioned JSON output.

## Tools

| Tool | Purpose |
| --- | --- |
| [npm-dep-audit](tools/npm-dep-audit/README.md) | Report direct npm vulnerability advisories by exact installed package version. |
| [npm-dep-paths](tools/npm-dep-paths/README.md) | Group the requirements declared by direct dependents of an installed package version, with optional upstream graph detail. |
| [npm-dep-versions](tools/npm-dep-versions/README.md) | List stable or prerelease versions and publication dates with semantic version filters and a cached catalog. |
| [npm-dep-upgrade](tools/npm-dep-upgrade/README.md) | Apply one safe within-range upgrade by planner hash, verify isolation, and commit dependency files. |
| [npm-dep-upgrade-plan](tools/npm-dep-upgrade-plan/README.md) | Report per-installation eligibility for ordered, read-only vulnerability remediation strategies. |

`npm-dep-audit` uses the separately installed `npm-dep-paths` CLI to show which declared requirements resolved to vulnerable versions. Install `npm-dep-paths` as a standalone command and keep it on `PATH` when running the audit tool; each tool has its own setup and usage instructions in its README.

`npm-dep-upgrade-plan` consumes the public JSON output from `npm-dep-audit` and checks stable versions through the separately installed `npm-dep-versions` CLI, which merges registry versions and publication dates in one npm command. Its versioned report has one row per vulnerable package version and target installation location, and it does not change the target project. Install `npm-dep-paths`, `npm-dep-audit`, `npm-dep-versions`, and `npm-dep-upgrade-plan` as standalone commands and keep them on `PATH` when using the planner.

`npm-dep-upgrade` reruns the planner, accepts an optional project directory plus one full or abbreviated item hash, and applies a verified upgrade with scripts disabled before creating a local commit. It requires all four analysis CLIs on `PATH` and clean dependency files with an empty staging area.

## Analysis caches

All four analysis tools cache structured results outside the target project by default. Paths invalidates by project content and query; versions enforces catalog TTLs, while audit and upgrade planning enforce source/advisory TTLs (one hour by default). Output formats share results. Use `--no-cache` on any analysis tool to bypass its cache; planner and audit propagate bypass to their nested analysis calls. Versions, audit, and planner also accept `--cache-ttl`, such as `30m`.

`npm-dep-versions react --major 19` lists stable releases with dates; add `--all` for prereleases or use `--range '>=19.0.0 <20'` for semantic version bounds. Its `--project` selects npm configuration context without requiring dependency files. Catalog filters and formats share cached data, and planner results expire no later than their oldest audit or catalog source.

Upgrade continues to rerun the planner for ID selection and independently performs fresh security checks before and after mutation. See each tool guide for cache keys, expiry and invalidation details.

## Debug logging

Add `--debug` to any tool to log external actions and cache decisions to stderr:

```sh
npm-dep-upgrade-plan /path/to/project --debug --format json > report.json 2> debug.log
```

The report stays on stdout. Each subprocess has a start record with its command, arguments and working directory, followed by an end record with its duration and exit status, signal or launch error. Records include a process ID and action number so concurrent operations can be paired. Logs cover npm context queries, registry lookups, audits, sibling tools, and upgrade's installs, Git commands and hook runner. Upgrade's direct security requests log their HTTP method, endpoint and outcome.

Debug mode propagates to sibling tools and streams their debug records to the caller. Use versions of all five tools that support `--debug`. Cache hits, misses and bypasses are logged; debug mode keeps normal cache behavior. Use `--no-cache` on an analysis tool when you also want fresh analysis.

Credentials in command arguments and URLs are redacted. Debug records omit environment values, request bodies and subprocess stdout/stderr. Existing error diagnostics and npm installation progress still follow each tool's normal behavior. Logging covers actions launched by these tools, rather than commands or network requests performed internally by npm or user hooks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide, including the required Conventional Commit format for commit messages and pull request titles.

## Design documents

- [Audit CLI design](docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md)
- [Paths CLI design](docs/superpowers/specs/2026-10-13-npm-dep-paths-design.md)
- [Upgrade planner CLI design](docs/superpowers/specs/2026-10-13-npm-dep-upgrade-plan-design.md)
- [Upgrade CLI design](docs/superpowers/specs/2026-10-20-npm-dep-upgrade-design.md)
- [Upgrade CLI E2E cases and fixture manifests](docs/superpowers/specs/2026-10-20-npm-dep-upgrade-e2e-cases.md)

- [Versions catalog design](docs/superpowers/specs/2026-10-21-npm-dep-versions-design.md)
