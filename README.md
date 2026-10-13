# npm-dep-flow

Small command-line tools for maintaining Node.js project dependencies.

Each tool is an independent Node.js project under `tools/`, with its own package manifest, lockfile, dependencies, executable, tests, and usage guide. The repository root is for shared documentation; it is not an npm package or workspace. Tools can exchange data through their documented command-line interfaces, including versioned JSON output.

## Tools

| Tool | Purpose |
| --- | --- |
| [npm-dep-audit](tools/npm-dep-audit/README.md) | Report direct npm vulnerability advisories by exact installed package version. |
| [npm-dep-paths](tools/npm-dep-paths/README.md) | Group the requirements declared by direct dependents of an installed package version, with optional upstream graph detail. |

`npm-dep-audit` uses the separately installed `npm-dep-paths` CLI to show which declared requirements resolved to vulnerable versions. Install `npm-dep-paths` as a standalone command and keep it on `PATH` when running the audit tool; each tool has its own setup and usage instructions in its README.

## Design documents

- [Audit CLI design](docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md)
