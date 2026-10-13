# npm dependency paths CLI

## Purpose and scope

Create `npm-dep-paths` as a standalone, reusable command in `tools/npm-dep-paths/`. A maintainer uses it to see every logical route from an npm project's root to a selected installed package, and the dependency spec declared at every step. This makes exact pins distinguishable from ranges when investigating how to update a vulnerable package.

The first phase creates and tests this tool only. It does not change `npm-dep-audit`. A later phase may consume the new tool's versioned JSON output to replace the audit report's installed `paths` field.

The tool reads the target project's `package.json` and `package-lock.json` without installing packages or changing the target. It supports npm lockfile versions 2 and 3 for ordinary, single-package projects. As with the existing audit tool, npm workspaces, local `file:` dependencies, linked packages, shrinkwrap files, and other package managers are outside the first release. Unsupported structures fail clearly instead of producing a possibly incomplete result.

## Command and results

The command is `npm-dep-paths <project> <package-selector> [--format text|json]`. Text is the default. `<project>` is a directory containing the target files. The selector is either a package name, including scoped names, or a package name with an exact installed version, such as `brace-expansion@5.0.9` or `@scope/name@1.2.3`. A range is not an exact-version selector.

One result item represents one package name and exact installed version reachable from the project root and contains every route to that version. A name-only query returns a list of result items grouped by version; an exact-version query returns one item. Result items sort by version ascending, and routes sort by their sequence of requested names, resolved versions, and lockfile locations. A name-only query with no matching package succeeds with an empty list. An exact-version query with no match fails with a `version not found` error.

The text report renders each result item as its own `npm ls` style tree. It starts with `name@version` and a route count, followed by the project root and all routes for that version. Shared prefixes may be merged for display, but every distinct route must remain visible. Each non-root node shows the dependency type and raw spec declared by its immediate parent, for example `brace-expansion@5.0.9 [dependency: ^5.0.5]` or `brace-expansion@5.0.9 [dependency: 5.0.9]`. A node resolved to an ancestor's installation may be marked `deduped` without hiding that route. The root has no incoming dependency spec.

JSON is a documented, versioned contract. Its common fields are `schemaVersion: 1`, `project: { name, version }`, and `selector`. For an exact-version selector it has `result`; for a name-only selector it has `results`. Each item has `package`, `version`, `routeCount`, and `routes`. A route is an ordered root-to-target array of nodes. Each node has resolved `name`, `version`, and `location`; its `incoming` field is `null` at the root and `{ name, type, spec }` elsewhere. `incoming.name` is the requested dependency name, `type` is the declaration field, and `spec` is its verbatim value. This keeps alias names and resolved package identities separate. JSON carries the complete routes rather than an already merged display tree.

## Data flow and resolution

1. Read and validate the root manifest and lockfile. The root manifest supplies the project's direct declarations; lockfile `packages` entries supply resolved installations and their dependency declarations. No registry lookup or `npm ls` subprocess is required.
2. Build a graph of resolved package locations. For each declaration, resolve the requested package using npm's package lookup rules for nested and hoisted installations. Include normal, development, optional, and peer dependency edges. Preserve the declaration's original spec even if the resolved version differs because of npm overrides.
3. Resolve aliases by the requested dependency name and retain both that name and the resolved package's own name. Group query results by the resolved package name and exact version.
4. Validate all required edges reachable from the project root before rendering. A required declaration with no resolvable installation, malformed relevant lockfile entry, or unsupported structure stops the report and identifies the declaring package and dependency. An absent optional dependency or optional peer contributes no edge and is allowed. An optional edge with a present but malformed destination is an error.
5. Enumerate distinct root-to-target routes by edge sequence. Do not use a global visited set: two dependents reaching one installation yield two routes. A route cannot repeat the same lockfile location; stop a cycle only within the current traversal route, so enumeration is finite without suppressing other routes.
6. Group routes by exact version, then render text or JSON. Do not cap depth, route count, or output size. Validate before writing stdout so errors cannot leave a partial report. Stream the completed output to stdout rather than using a child-process output buffer.

The graph represents logical dependency relationships, not a listing of physical directories. This follows the purpose of `npm ls`, while the lockfile source also covers dependencies that are recorded but omitted from `node_modules`. Text layout may differ from npm's exact spacing or branch order; route membership, versions, and declared specs are the correctness contract.

## Error and exit behavior

A complete report exits 0, including a name-only query with no results. Invalid arguments, an absent exact version, invalid or unsupported project input, and unresolved required relationships exit 1, write a specific error to stderr, and write no partial report to stdout. The tool neither installs dependencies nor runs lifecycle scripts. A successful `npm install` is expected before querying; legitimately absent optional dependencies remain allowed.

## Repository structure and verification

`tools/npm-dep-paths/` has its own manifest, lockfile, executable, source modules, tests, and README, following the repository's independent-tool convention. Separate units load and validate the project, resolve graph edges, enumerate and group routes, and render output. The CLI coordinates those units without importing private `npm-dep-audit` source files.

Fixture tests cover lockfile versions 2 and 3; scoped selectors; name-only grouping and exact-version selection; several routes to one installation; multiple installed versions; hoisted, nested, alias, peer, and optional relationships; declared specs at every edge; cycles; unsupported inputs; unresolved required edges; absent optional edges; deterministic text and JSON; and no stdout on failure. A larger fixture checks that complete output is not truncated. Representative fixtures are compared with `npm ls --package-lock-only` to check route membership, but `npm ls` is not a runtime dependency or output parser.
