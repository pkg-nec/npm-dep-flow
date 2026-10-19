# npm-dep-audit

Report direct npm vulnerability advisories, grouped by exact installed package version. The tool reads `package.json` and `package-lock.json`, runs `npm audit --json`, and never installs or changes dependencies in the checked project.

## Requirements and installation

Use Node.js 20 or newer, npm with access to the target project's audit registry, and a supported npm project. The separately installed `npm-dep-paths` command must be on `PATH` when findings need dependency requirements.

Starting at the repository root, install both independent commands:

```sh
cd tools/npm-dep-paths
npm ci --ignore-scripts
npm install --global . --ignore-scripts
cd ../npm-dep-audit
npm ci --ignore-scripts
npm install --global . --ignore-scripts
```

Keep npm's global executable directory on `PATH`. Global installation is optional for this tool's own local execution; its paths CLI prerequisite remains necessary.

## Usage

```sh
npm-dep-audit /path/to/project
npm-dep-audit /path/to/project --min-severity high --format json
npm-dep-audit /path/to/project --cache-ttl 30m
npm-dep-audit /path/to/project --no-cache
npm-dep-audit --version
npm-dep-audit --help
```

For local development, from `tools/npm-dep-audit/`, use `node bin/npm-dep-audit.js /path/to/project` with the same options.

The project path defaults to the current directory. `--format markdown|json` defaults to `markdown`. `--version` prints the version and absolute installed tool directory; `--help` also shows the version. `--min-severity` accepts `info`, `low`, `moderate`, `high`, or `critical` (default `info`). A row is kept when its highest advisory severity meets the threshold; all matching direct advisories remain in that row.

## Human-readable report

Markdown starts with the tool name. Rows group advisories by exact installed version and show declared requirements with their direct dependents and dependency types. Repeated visible dependent labels include installation counts. For example, illustrative fixture data produces:

```markdown
# npm-dep-audit

| Package | Version | Highest severity | Advisories | Declared requirements |
| --- | --- | --- | --- | --- |
| brace-expansion | 5.0.9 | <strong style="color: red">high</strong> | ([123](https://example.test/advisory)) Fixture advisory | ^5.0.5 → minimatch@10.2.5 [dependencies] |
```

An empty or fully filtered report contains the title and `No matching direct advisories.`, without a table.

In Markdown, each advisory appears as `(code) title`, with only the code linked. The code is the GHSA identifier from its URL when available, or the advisory ID otherwise. Highest severity uses npm audit's colors in Markdown viewers that support inline HTML styles: moderate is yellow, high is red, and critical is magenta. Low and info are bold without a color.

User-controlled Markdown values display literally: Markdown and HTML characters are escaped, and control characters are shown as visible escapes. JSON preserves original values.

For full upstream routes, use the summary and optional `--upstream-of` queries in the [npm-dep-paths guide](../npm-dep-paths/README.md).

## JSON contract

The JSON format has `schemaVersion: 2`, `auditedAt`, and `rows`. Each row contains `package`, `version`, `severity`, `advisories`, and `requirements`; each requirement has `declaredRequirement` and `directDependents`. Dependents include their resolved `name` and `version`, lockfile `location`, vulnerable package `targetLocation`, declaration `type`, and `requestedName` (which preserves npm aliases). Only dependent links that lead to an affected installed copy are included; the previous `paths` field is no longer part of the public JSON output.

An illustrative response is:

```json
{
  "schemaVersion": 2,
  "auditedAt": "2026-10-13T06:00:00.000Z",
  "rows": [
    {
      "package": "brace-expansion",
      "version": "5.0.9",
      "severity": "high",
      "advisories": [
        {
          "id": 123,
          "title": "Fixture advisory",
          "url": "https://example.test/advisory",
          "severity": "high",
          "range": "<5.0.12"
        }
      ],
      "requirements": [
        {
          "declaredRequirement": "^5.0.5",
          "directDependents": [
            {
              "name": "minimatch",
              "version": "10.2.5",
              "location": "node_modules/minimatch",
              "targetLocation": "node_modules/brace-expansion",
              "type": "dependencies",
              "requestedName": "brace-expansion"
            }
          ]
        }
      ]
    }
  ]
}
```

## Cache behavior

The cache defaults to one hour and lives under `XDG_CACHE_HOME/npm-dep-audit` or `~/.cache/npm-dep-audit`. It is keyed by the project and hashes of both manifest files, npm version, and audit registry. `--cache-ttl` takes a positive number followed by `s`, `m`, `h`, or `d`. `--no-cache` bypasses reads and writes.

## Supported projects

Supports ordinary single-package npm projects with lockfile versions 2 and 3. Workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers are unsupported. Dependency requirements follow logical lockfile relationships, including affected physical installation locations.

## Errors and exit codes

A completed report exits 0 even when vulnerabilities are found. Errors exit 1, write diagnostics to stderr, and leave stdout empty. Missing, failed, or malformed responses from `npm-dep-paths` fail the report without partial output.

## Development

From `tools/npm-dep-audit/`, run `npm ci --ignore-scripts` and `npm test`. Set `NPM_DEP_PATHS_INTEGRATION=1` to include the integration test against the separately installed paths command on `PATH`. Normal tests use controlled audit data and do not need a live audit registry.

The [audit design](../../docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md) describes the data flow and contracts.
