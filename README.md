# npm-dep-flow

Small command-line tools for maintaining Node.js project dependencies.

Each tool is an independent Node.js project under `tools/`, with its own package manifest, lockfile, dependencies, executable, tests, and usage guide. The repository root is for shared documentation; it is not an npm package or workspace. Tools can exchange data through their documented command-line interfaces, including versioned JSON output.

## Tools

| Tool | Purpose |
| --- | --- |
| [npm-dep-audit](tools/npm-dep-audit/README.md) | Report direct npm vulnerability advisories by exact installed package version. |

## Design documents

- [Audit CLI design](docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md)
