# npm dependency paths CLI

## Purpose and scope

`npm-dep-paths` is a standalone command in `tools/npm-dep-paths/` for deciding how to update an installed package version. Its normal report groups the exact dependency requirements that resolved to that version and lists the direct dependents making each declaration. When a maintainer needs to see why one of those dependents is present, an explicit upstream query supplies its complete logical dependency graph. This keeps the normal report short even when shared installations yield thousands of root-to-target routes.

The command reads a target project's `package.json` and `package-lock.json` without installing packages or changing the target. It supports npm lockfile versions 2 and 3 for ordinary, single-package projects. npm workspaces, local `file:` dependencies, linked packages, shrinkwrap files, and other package managers remain unsupported and fail clearly. A successful `npm install` is expected before querying; absent optional dependencies and optional peers are allowed.

## Command and selection

The command is `npm-dep-paths <project> <package-selector> [--format markdown|json] [--upstream-of <package@exact-version> [--from <package@exact-version>]]`. Markdown is the default; `text` remains an accepted alias with identical output. The project is a directory containing the target files. The selector is either a resolved package name, including scoped names, or that name followed by an exact installed version. A range is not an exact-version selector.

A name-only query returns one result per reachable installed version, sorted by semantic version. An exact-version query returns one result. A name-only query with no match succeeds with an empty result list; an absent exact version fails. `--upstream-of` requires an exact target selector and names a direct dependent by its resolved name and exact version. It selects every installed copy of that dependent with a qualifying direct edge to the selected target version. `--from` requires `--upstream-of`, names a top-level package by resolved name and exact version, and keeps only upstream connections through matching direct root dependencies. The normal target summary remains unchanged by either filter.

An `--upstream-of` dependent that does not directly lead to the selected target, or a `--from` package that does not lead to the selected dependent, is an error. A selected dependent may be the project root if the root directly declares the target; then it has no upstream parents or top-level entries. If several physical installations have the same selected name and version, all qualifying installations are included and identified by their lockfile locations.

## Default report

Each result represents one resolved package name and exact installed version. Its two logical columns are **Declared requirement** and **Direct dependents**. Requirements are grouped by their verbatim declaration strings: `^5.0.5` and `^5.0.6` occupy separate rows even if both resolve to `5.0.9`. Every direct dependency link that can end a simple root-to-target route contributes to its requirement group. Each direct dependent carries its resolved name, version, dependency type, requested dependency name, parent lockfile location, and target lockfile location. Distinct physical links remain distinct in JSON. Text may combine repeated visible package labels only if it shows their installation count and does not hide distinct requirements or dependency types.

For example, a `brace-expansion@5.0.9` report may be:

```markdown
# npm-dep-paths

## brace-expansion@5.0.9

| Declared requirement | Direct dependents |
| --- | --- |
| 5.0.9 | nx@23.1.2 \[dependencies\] |
| ^5.0.5 | minimatch@10.2.5 \[dependencies\] |
| ^5.0.6 | other-tool@1.0.0 \[dependencies\] |
```

Each result uses an H2 below the report H1. Upstream overview and tree detail are appended inside a `text` code block, with a backtick fence longer than any backtick run in its content. Code-block values retain Markdown punctuation while control characters remain visible escapes.

Results and requirement groups have deterministic order. Versions sort by semantic version; requirement strings sort lexically; dependent links sort by resolved name, version, parent location, target location, type, then requested name. The report has no route count because the number of possible routes can be much larger than the number of distinct dependency relationships.

Human-readable reports begin with one `# npm-dep-paths` heading. Empty output retains the heading and the tool-specific no-matches message without an empty table. User-controlled values in Markdown cells and headings escape backslashes, pipes, brackets, emphasis and code markers, and HTML characters. LF, CR, and tab display as visible escapes; other C0 controls and DEL display as `\xNN`. Preserve Unicode and original JSON values.

## JSON contract

JSON has `schemaVersion: 2`, `project: { name, version }`, and `selector`. An exact-version query has `result`; a name-only query has `results`. Each result has `package`, `version`, and `requirements`. Each requirement object has exactly the two report fields `declaredRequirement` and `directDependents`. A direct dependent has `name`, `version`, `location`, `targetLocation`, `type`, and `requestedName`. The empty string is the root location. `type` is the original declaration field: `dependencies`, `devDependencies`, `optionalDependencies`, or `peerDependencies`. `requestedName` can differ from the resolved target package name for an npm alias.

Example exact-version result:

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
        "declaredRequirement": "5.0.9",
        "directDependents": [
          {
            "name": "nx", "version": "23.1.2", "location": "node_modules/nx",
            "targetLocation": "node_modules/brace-expansion", "type": "dependencies",
            "requestedName": "brace-expansion"
          }
        ]
      }
    ]
  }
}
```

Without `--upstream-of`, JSON contains only this summary contract; it does not include a graph or expanded routes. Name-only no-match output has `results: []`. The previous route-array schema was never merged and is replaced rather than retained as a compatibility format.

## Upstream detail

`--upstream-of` adds `upstream` to the exact-version JSON envelope while retaining the complete, unfiltered `result` summary. `upstream` has `selectedDependent`, `rootLocation`, `selectedLocations`, `targetLocations`, `topLevelLocations`, `nodes`, and `edges`. The selected dependent is the supplied `name@version`. Locations refer to lockfile package locations and are stable node IDs within one report. Each node has `location`, `name`, and `version`. Each edge has `from`, `to`, `requestedName`, `type`, and the verbatim declared `spec`. Nodes and edges include the root-reachable ancestor graph for qualifying selected-dependent installations and their final links to matching target installations. Shared packages and links appear once. Cycles are retained as links; a route through this graph cannot revisit a location. Nodes, edges, and location lists sort deterministically by location and edge identity.

Without `--from`, upstream text is an overview: the selected dependent and its requirement on the target, every distinct immediate parent declaration, every top-level package that leads to it, and the counts of unique upstream nodes and links. It never silently truncates a list. With `--from`, text displays the complete filtered upstream graph beneath the chosen top-level package. A repeated installed package is shown as a reference to its first display occurrence, with every connecting edge and declared spec still visible. Cycles are references rather than recursive expansions. JSON contains the filtered graph when `--from` is supplied; its `result` summary remains unfiltered.

The upstream graph represents logical declared dependency relationships. It is not a physical directory listing or a pre-enumerated list of all routes. Consumers can derive distinct simple routes by traversing its edges from root to a selected target location without repeating a location.

## Data flow and resolution

1. Read and validate the root manifest and lockfile. The root manifest supplies direct declarations; lockfile `packages` entries supply resolved installations and declarations. No registry lookup, `npm ls` subprocess, or `node_modules` access is required.
2. Build a graph keyed by resolved lockfile location. For each declaration, resolve the requested package using npm's nested and hoisted lookup rules. Include normal, development, optional, and peer edges, subject to the existing root-only development rule. Preserve the declaration's raw spec even when npm overrides change the installed version.
3. Resolve aliases by requested name while retaining the resolved package's own name. Query selectors match resolved names. Validate all required edges reachable from the root before producing output. An absent optional dependency or optional peer contributes no edge; a present malformed destination is an error.
4. Select matching target nodes from the validated graph. For each matching target, inspect incoming edges and include an edge in the summary when its parent is reachable from the root without first visiting that target location. This preserves the earlier simple-route interpretation in cyclic graphs without enumerating routes. Group the qualifying edges by exact target version and raw spec.
5. On an upstream query, select matching direct-dependent locations from those qualifying incoming edges, collect their root-reachable ancestor links, and add the selected-dependent-to-target links. Apply `--from` only to the detail graph. Build the complete report before writing stdout.

Normal queries must not enumerate or materialize root-to-target routes. Their work and output should scale with reachable graph nodes and links, not with the number of possible routes. Upstream JSON and focused text likewise emit each relevant graph node and link once.

## Errors and verification

A complete report exits 0. Invalid arguments, an absent exact target, invalid or unsupported project input, unresolved required relationships, a non-direct `--upstream-of` selection, or an unrelated `--from` selection exit 1, write a specific error to stderr, and write no partial report to stdout. The command neither installs dependencies nor runs lifecycle scripts.

Tests cover lockfile versions 2 and 3; scoped names and aliases; name-only grouping and exact selection; several raw specs resolving to one version; multiple installed copies; hoisted, nested, peer, and optional relationships; cycles; upstream selection and filtering; deterministic text and JSON; unsupported and unresolved inputs; and no stdout on failure. A synthetic convergent graph verifies that compact reports remain bounded by distinct nodes and links despite many possible routes. Representative fixture relationships can be checked against `npm ls --package-lock-only`, but npm is not a runtime dependency or output parser.

The branch retains one canonical design spec and one canonical implementation plan for this tool. This spec and the existing plan are revised to describe the final behavior before the branch is integrated. `tools/npm-dep-audit/` remains unchanged.
