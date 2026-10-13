# npm-dep-paths

Show every dependency route from an npm project root to a selected installed package, with the version spec declared at each step. The tool reads the target project's `package.json` and `package-lock.json`; it does not require `node_modules`, install packages, run lifecycle scripts, or change the target.

## Use

From `tools/npm-dep-paths/`, install this tool's own dependency with `npm ci --ignore-scripts`, then run:

```sh
node bin/npm-dep-paths.js /path/to/project brace-expansion
node bin/npm-dep-paths.js /path/to/project brace-expansion@5.0.9
node bin/npm-dep-paths.js /path/to/project brace-expansion@5.0.9 --format json
```

A name-only query returns one result item per reachable exact version. An exact-version query returns one item containing every route to that version. The default text report renders a separate `npm ls` style tree for each item. Each non-root node shows the dependency declaration made by its parent, such as `[dependency: ^5.0.5]` or `[dependency: 5.0.9]`. Shared installed packages appear on every route that reaches them.

## JSON contract

JSON has `schemaVersion: 1`, `project: { name, version }`, and `selector`. A name-only query has a `results` array; an exact-version query has one `result` object. Each result contains `package`, `version`, `routeCount`, and `routes`. A route is an ordered array from project root to target. Each node has `name`, `version`, `location`, and `incoming`: `null` at the root, otherwise `{ name, type, spec }`. `incoming.name` is the requested dependency name, which can differ from the resolved node name for an npm alias. `type` is the declaration field (`dependencies`, `devDependencies`, `optionalDependencies`, or `peerDependencies`); `spec` is the exact string declared by the parent.

A name-only query with no matching package returns an empty `results` array and exits 0. An exact version that is not found exits 1. Invalid input, an unsupported project structure, or an unresolved required dependency also exits 1 with an error on stderr and no partial report on stdout. Absent optional dependencies and optional peers are allowed and do not create routes.

This release supports ordinary single-package npm projects with lockfile versions 2 and 3. It rejects workspaces, local `file:` and linked packages, shrinkwrap files, and other package managers. It reports logical dependency routes from the lockfile rather than the physical layout of `node_modules`.
