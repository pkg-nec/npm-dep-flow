# npm-dep-audit

A command line report of direct npm vulnerability advisories, grouped by exact installed package version. It reads `package.json` and `package-lock.json`, runs `npm audit --json`, and never installs or changes dependencies in the checked project.

## Use

From `tools/npm-dep-audit/`, install this tool's own dependency with `npm ci --ignore-scripts`, then run it with the path to the project you want to check:

```sh
node bin/npm-dep-audit.js /path/to/project
node bin/npm-dep-audit.js /path/to/project --min-severity high --format json
node bin/npm-dep-audit.js /path/to/project --cache-ttl 30m
node bin/npm-dep-audit.js /path/to/project --no-cache
```

The project path defaults to the current directory. Markdown is the default format. `--min-severity` accepts `info`, `low`, `moderate`, `high`, or `critical`; a row is kept when its highest advisory severity meets the threshold, and all direct advisories for that version remain in the row. The JSON format has `schemaVersion: 1`, `auditedAt`, and `rows`. Each row contains `package`, `version`, `severity`, `advisories`, and `paths`.

The cache defaults to one hour and lives under `XDG_CACHE_HOME/npm-dep-audit` or `~/.cache/npm-dep-audit`. It is keyed by the project and hashes of both manifest files, npm version, and audit registry. `--cache-ttl` takes a positive number followed by `s`, `m`, `h`, or `d`. `--no-cache` bypasses reads and writes.

A completed report exits 0 even if vulnerabilities are found. Errors exit 1 and write to stderr; stdout contains no partial report. This version supports lockfile versions 2 and 3. It rejects npm workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers.
