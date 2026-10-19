# npm-dep-paths

Inspect how an npm project's installed package versions are required. The normal report groups direct dependents by the exact version requirement they declared. An optional upstream query shows how a selected direct dependent is reached from the project root. The tool reads `package.json` and `package-lock.json`; it does not install packages, run lifecycle scripts, or change the target.

## Requirements and installation

Use Node.js 20 or newer and a supported npm project. The CLI reads lockfile data; it needs neither `node_modules` nor npm or registry access at runtime. npm is used to install the tool's own dependencies.

Starting at the repository root:

```sh
cd tools/npm-dep-paths
npm ci --ignore-scripts
npm install --global . --ignore-scripts
```

Keep npm's global executable directory on `PATH` so audit can invoke this independent command.

## Usage

```sh
npm-dep-paths brace-expansion
npm-dep-paths --format json brace-expansion@5.0.9
npm-dep-paths /path/to/project brace-expansion
npm-dep-paths /path/to/project brace-expansion@5.0.9
npm-dep-paths /path/to/project brace-expansion@5.0.9 --format json
npm-dep-paths /path/to/project brace-expansion@5.0.9 --upstream-of minimatch@10.2.5
npm-dep-paths /path/to/project brace-expansion@5.0.9 --upstream-of minimatch@10.2.5 --from @nx/devkit@23.1.2
npm-dep-paths --help
npm-dep-paths --version
```

For local execution without a global install, from `tools/npm-dep-paths/`, use `node bin/npm-dep-paths.js /path/to/project brace-expansion` with the same options.

Usage: `npm-dep-paths [project] <package-selector> [options]`. The project directory defaults to `.` (the caller’s current directory); the package selector is required. With one positional argument, it is the selector; with two, they are the project directory followed by the selector. Options may appear before or after positional arguments. `--format markdown|json` defaults to `markdown`; `text` is retained as a compatibility alias for the same Markdown output. `--version` prints the version and absolute installed tool directory; `--help` also shows the version.

A name-only query produces one result per reachable installed version. An exact-version query produces one result. `npm-dep-audit` uses name-only JSON queries to identify affected dependent links; see the [audit guide](../npm-dep-audit/README.md).

## Human-readable report

Markdown starts with the tool name, then one H2 and a table per result. Requirements such as `^5.0.5` and `^5.0.6` remain distinct even when both resolve to `5.0.9`. Repeated visible dependent labels include their installation count. There is no route count. For example:

```markdown
# npm-dep-paths

## brace-expansion@5.0.9

| Declared requirement | Direct dependents |
| --- | --- |
| ^5.0.5 | minimatch@10.2.5 \[dependencies\] |
```

A name-only query with no matches contains the title and `No matching installed packages.`, without a table. Markdown and HTML characters in values display literally, and control characters appear as visible escapes; JSON preserves original strings.

`--upstream-of` requires an exact target version and the exact resolved name and version of a direct dependent. Text then lists the selected dependent's requirement on the target, all of its immediate parents, and every top-level package leading to it, along with upstream graph size. Add `--from` with an exact top-level name and version to display only that branch as a tree. Shared installations and cycles appear as references, with every connecting declaration still shown. The default summary remains complete when either option is used.

Upstream overview and tree detail are enclosed in a `text` code block after the summary so indentation and reference markers render correctly. Fences grow when the text contains backtick runs.

## JSON contract

JSON uses `schemaVersion: 2`, `project: { name, version }`, and `selector`. A name-only query has `results`; an exact-version query has `result`. Each result has `package`, `version`, and `requirements`. Each requirement group has `declaredRequirement` and `directDependents`. Every direct dependent has `name`, `version`, `location`, `targetLocation`, `type`, and `requestedName`. Locations identify physical installations in the lockfile. `type` is the declaration field (`dependencies`, `devDependencies`, `optionalDependencies`, or `peerDependencies`). `requestedName` retains an npm alias name when it differs from the resolved target's name.

A normal exact-version response looks like:

```json
{
  "schemaVersion": 2,
  "project": { "name": "demo", "version": "1.0.0" },
  "selector": "brace-expansion@5.0.9",
  "result": {
    "package": "brace-expansion",
    "version": "5.0.9",
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
}
```

With `--upstream-of`, exact-version JSON keeps the same unfiltered `result` and adds `upstream`. That object has `selectedDependent`, `rootLocation`, `selectedLocations`, `targetLocations`, `topLevelLocations`, `nodes`, and `edges`. Nodes contain `location`, `name`, and `version`. Edges contain `from`, `to`, `requestedName`, `type`, and the parent's verbatim `spec`. Every package location and relationship appears once. `--from` filters only `upstream`; it does not filter the result summary. Consumers can traverse the graph to inspect simple routes without expanding every possible route in the report.

## Supported projects

Supports ordinary single-package npm projects with lockfile versions 2 and 3. Workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers are unsupported. Reports use logical dependency relationships from the lockfile rather than the physical directory layout of `node_modules`. Absent optional dependencies and optional peers do not create links.

## Errors and exit codes

A completed report exits 0, including name-only queries with no matches (`results: []`). An absent exact target, invalid upstream or branch selection, invalid input, unsupported project structure, or unresolved required dependency exits 1 with a specific stderr diagnostic and no partial stdout.

## Development

From `tools/npm-dep-paths/`, run `npm ci --ignore-scripts` and `npm test`. The suite includes real executable checks without `node_modules` in the fixture project and needs no live registry or separately installed sibling tool.

The [paths design](../../docs/superpowers/specs/2026-10-13-npm-dep-paths-design.md) describes selection, resolution, and graph contracts.
