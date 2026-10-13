# npm-dep-paths

Inspect how an npm project's installed package versions are required. The normal report groups direct dependents by the exact version requirement they declared. An optional upstream query shows how a selected direct dependent is reached from the project root. The tool reads the target project's `package.json` and `package-lock.json`; it does not require `node_modules`, install packages, run lifecycle scripts, or change the target.

## Use

Install this tool's dependencies and expose the CLI globally from the repository root so other tools, including `npm-dep-audit`, can invoke `npm-dep-paths` from `PATH`:

```sh
cd tools/npm-dep-paths
npm ci --ignore-scripts
npm install --global . --ignore-scripts
npm-dep-paths --help
```

For local development without a global install, run its entry point directly:

```sh
node bin/npm-dep-paths.js /path/to/project brace-expansion
node bin/npm-dep-paths.js /path/to/project brace-expansion@5.0.9
node bin/npm-dep-paths.js /path/to/project brace-expansion@5.0.9 --format json
node bin/npm-dep-paths.js /path/to/project brace-expansion@5.0.9 --upstream-of minimatch@10.2.5
node bin/npm-dep-paths.js /path/to/project brace-expansion@5.0.9 --upstream-of minimatch@10.2.5 --from @nx/devkit@23.1.2
```

A name-only query produces one result per reachable installed version. An exact-version query produces one result. The default text report lists each distinct declared requirement first, followed by all direct dependents that made it. `^5.0.5` and `^5.0.6` remain separate even if both resolved to `5.0.9`. A dependent's dependency type is shown beside its name; repeated physical installations are counted. The summary has no route count.

`npm-dep-audit` runs a name-only JSON query and uses the declared requirements and direct dependent links to replace its former installed-paths column. The integration requires this CLI to be separately installed and available on `PATH`; see the [npm-dep-audit guide](../npm-dep-audit/README.md) for setup and its report format.

`--upstream-of` requires an exact target version and the exact resolved name and version of a direct dependent. Text then lists the selected dependent's requirement on the target, all of its immediate parents, and every top-level package leading to it, along with upstream graph size. Add `--from` with an exact top-level name and version to display only that branch as a tree. Shared installations and cycles appear as references, with every connecting declaration still shown. The default summary remains complete when either option is used.

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

A name-only query with no match returns `results: []` and exits 0. An absent exact target, a non-direct `--upstream-of` selection, an unrelated `--from` selection, invalid input, an unsupported project structure, or an unresolved required dependency exits 1 with a specific stderr error and no partial stdout. Absent optional dependencies and optional peers do not create links.

This release supports ordinary single-package npm projects with lockfile versions 2 and 3. It rejects workspaces, local `file:` and linked packages, shrinkwrap files, and other package managers. Reports use logical dependency relationships recorded in the lockfile, not the physical directory layout of `node_modules`.
