# npm-dep-flow

Small command-line tools for maintaining Node.js project dependencies.

Each tool is an independent Node.js project under `tools/`, with its own package manifest, lockfile, dependencies, executable, tests, and usage guide. The repository root is for shared documentation; it is not an npm package or workspace. Tools can exchange data through their documented command-line interfaces, including versioned JSON output.

## Tools

| Tool | Purpose |
| --- | --- |
| [npm-dep-audit](tools/npm-dep-audit/README.md) | Report direct npm vulnerability advisories by exact installed package version. |
| [npm-dep-paths](tools/npm-dep-paths/README.md) | Group the requirements declared by direct dependents of an installed package version, with optional upstream graph detail. |
| [npm-dep-upgrade-plan](tools/npm-dep-upgrade-plan/README.md) | Report per-installation eligibility for ordered, read-only vulnerability remediation strategies. |

`npm-dep-audit` uses the separately installed `npm-dep-paths` CLI to show which declared requirements resolved to vulnerable versions. Install `npm-dep-paths` as a standalone command and keep it on `PATH` when running the audit tool; each tool has its own setup and usage instructions in its README.

`npm-dep-upgrade-plan` consumes the public JSON output from `npm-dep-audit` and checks stable versions from the configured npm registry. Its versioned report has one row per vulnerable package version and target installation location, and it does not change the target project. Install `npm-dep-paths`, `npm-dep-audit`, and `npm-dep-upgrade-plan` as standalone commands and keep them on `PATH` when using the planner.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide, including the required Conventional Commit format for commit messages and pull request titles.

## Design documents

- [Audit CLI design](docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md)
