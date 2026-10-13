# npm-dep-audit

A command line report of direct npm vulnerability advisories, grouped by exact installed package version. It reads `package.json` and `package-lock.json`, runs `npm audit --json`, and never installs or changes dependencies in the checked project.

## Use

`npm-dep-audit` gets dependency requirements from the separately installed `npm-dep-paths` CLI. From the repository root, install the paths tool's dependencies and expose its command globally. Ensure npm's global executable directory is on `PATH`. Then install this tool's own dependency:

```sh
cd tools/npm-dep-paths
npm ci --ignore-scripts
npm install --global . --ignore-scripts
cd ../npm-dep-audit
npm ci --ignore-scripts
```

Run it with the path to the project you want to check:

```sh
node bin/npm-dep-audit.js /path/to/project
node bin/npm-dep-audit.js /path/to/project --min-severity high --format json
node bin/npm-dep-audit.js /path/to/project --cache-ttl 30m
node bin/npm-dep-audit.js /path/to/project --no-cache
```

The project path defaults to the current directory. Markdown is the default format. `--min-severity` accepts `info`, `low`, `moderate`, `high`, or `critical`; a row is kept when its highest advisory severity meets the threshold, and all direct advisories for that version remain in the row. The Markdown `Declared requirements` column groups identical requirements and lists their direct dependents, including the dependency type. The JSON format has `schemaVersion: 2`, `auditedAt`, and `rows`. Each row contains `package`, `version`, `severity`, `advisories`, and `requirements`; each requirement has `declaredRequirement` and `directDependents`. Dependents include their resolved `name` and `version`, lockfile `location`, vulnerable package `targetLocation`, declaration `type`, and `requestedName` (which preserves npm aliases). Only dependent links that lead to an affected installed copy are included; the previous `paths` field is no longer part of the public JSON output.

For the full route above a direct dependent, use `npm-dep-paths` directly. Its summary and optional `--upstream-of` graph detail are described in the [npm-dep-paths guide](../npm-dep-paths/README.md).

In Markdown, each advisory appears as `(code) title`, with only the code linked. The code is the GHSA identifier from its URL when available, or the advisory ID otherwise. Highest severity uses npm audit's colors in Markdown viewers that support inline HTML styles: moderate is yellow, high is red, and critical is magenta. Low and info are bold without a color.

The cache defaults to one hour and lives under `XDG_CACHE_HOME/npm-dep-audit` or `~/.cache/npm-dep-audit`. It is keyed by the project and hashes of both manifest files, npm version, and audit registry. `--cache-ttl` takes a positive number followed by `s`, `m`, `h`, or `d`. `--no-cache` bypasses reads and writes.

A completed report exits 0 even if vulnerabilities are found. Errors exit 1 and write to stderr; stdout contains no partial report. If `npm-dep-paths` is missing, fails, or returns invalid data, the audit report fails without partial output. This version supports lockfile versions 2 and 3. It rejects npm workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers.
