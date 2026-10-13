# npm-dep-paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the standalone CLI from exhaustive route reports to requirement-grouped summaries with optional compact upstream graph detail.

**Architecture:** Keep the existing validated lockfile graph as the source of truth. Collect qualifying incoming edges for each target version without enumerating routes; separately extract an upstream subgraph when requested. Render schema v2 JSON and text from these compact structures, then remove the superseded route renderer and enumerator.

**Tech Stack:** Node.js 20+ ES modules, `node:test`, npm `semver`; no npm subprocess or Arborist at runtime.

**Spec:** `docs/superpowers/specs/2026-10-13-npm-dep-paths-design.md`

## Global Constraints

- Work in the existing `feat/npm-dep-paths` worktree at `/home/maw/src/nrc/npm-dep-flow-impl/worktrees/npm-dep-paths`; do not modify `tools/npm-dep-audit/`.
- Keep one canonical spec and this one canonical plan under `docs/superpowers/`; any scratch files go under `/home/maw/src/nrc/npm-dep-flow-impl/tmp`.
- Read only the target project's `package.json` and `package-lock.json`; never install into it, change it, run lifecycle scripts, or require its `node_modules`.
- Support ordinary single-package npm projects with lockfile versions 2 and 3; keep existing clear failures for workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers.
- Keep validation of root-reachable required edges, optional omissions, npm aliases, overrides, hoisting, nested installs, and peer lookup from the existing graph builder.
- CLI: `npm-dep-paths <project> <package-selector> [--format text|json] [--upstream-of <package@exact-version> [--from <package@exact-version>]]`; text is default.
- `--upstream-of` requires an exact target selector. `--from` requires `--upstream-of` and selects a matching top-level package. Errors produce stderr and no partial stdout.
- Schema v2 has the existing project/selector envelope and `result` for exact queries or `results` for name-only queries. Normal JSON contains only requirement groups, no route arrays or graph. Upstream JSON adds `upstream`; `--from` filters only that detail graph.
- Group declarations by exact raw spec; retain distinct physical links and all original edge metadata. Normal and upstream queries must not enumerate all root-to-target routes.
- Install tool dependencies, if needed, only with `--ignore-scripts`. Final suite: `npm test` in `tools/npm-dep-paths/`.

## File map

- Keep `src/project.js` and `src/graph.js` as the validated project and graph source.
- Create `src/summary.js`: select target versions and group qualifying incoming links by exact declared spec.
- Create `src/upstream.js`: select the direct dependent and optional top-level branch, then return a deterministic subgraph.
- Create `src/report.js`: format the summary and upstream detail in text and schema v2 JSON.
- Move selector parsing from `src/routes.js` to `src/selector.js` during the CLI cutover; remove `src/routes.js` and `src/render.js` once unused. Tasks 1–3 pass selector object literals, so they do not depend on the removed module.
- Modify `src/cli.js`, `test/cli.test.js`, `tools/npm-dep-paths/README.md`, and the root `README.md` only as needed for the new contract. Add `test/summary.test.js`, `test/upstream.test.js`, `test/report.test.js`, and `test/selector.test.js`; remove obsolete route/render tests at cutover.

## Review Focus

- A target is directly declared by the project root: Task 1 tests the root as a dependent and Task 2 tests an upstream graph with no top-level entries.
- Several physical installations share one resolved name and version: Tasks 1–2 test that locations and their links remain distinct.
- A reachable dependency cycle points back to a target: Task 1 tests that an edge requiring a repeated target location does not enter the summary; Task 2 tests a finite graph with the cycle link retained.
- An npm alias has a requested name different from its resolved package name: Tasks 1 and 3 test selection by resolved name and retention of `requestedName`.
- A declared spec contains control or non-ASCII characters: Task 3 tests lossless JSON and escaped, readable text.

---

### Task 1: Collect compact requirement summaries

**Files:** Create `tools/npm-dep-paths/src/summary.js`, `tools/npm-dep-paths/test/summary.test.js`.

**Interfaces:** `collectSummaryResults(graph: Map<string, GraphNode>, selector: {kind, name, version?}) -> Result[]`, where `Result` is `{ package, version, requirements: [{ declaredRequirement, directDependents: [{ name, version, location, targetLocation, type, requestedName }] }] }`. The graph and selector are the existing shapes. Keep `parseSelector` in `routes.js` until Task 4.

- [ ] **Step 1: Write failing tests in `test/summary.test.js`.** Assert one installed `5.0.9` target produces separate `5.0.9`, `^5.0.5`, and `^5.0.6` groups; two parents with `^5.0.5` share one group; duplicate physical installations retain separate location pairs; an alias keeps the resolved target name and requested alias; a root declaration has `location: ''`; name selection orders `1.1.21`, `2.1.7`, `5.0.9`; missing name gives `[]`, missing exact version throws. Add a cycle fixture whose back-edge parent can only be reached after visiting the target and assert it is excluded. Add 20 connected diamonds (over a million possible routes) and assert summary size and content depend only on unique incoming links.
- [ ] **Step 2: Run `node --test test/summary.test.js`.** Expect an import failure because `summary.js` does not exist.
- [ ] **Step 3: Implement `collectSummaryResults` in `src/summary.js`.** Index incoming graph edges by destination location. For each matching target, include an incoming edge only when the root can reach its parent without visiting that target location; use iterative graph traversal so cycles and deep graphs are finite. Group by exact `edge.spec`, preserve the parent and target locations plus edge metadata, and sort versions, groups, and dependents as specified. Do not call or copy `collectResults` route enumeration.
- [ ] **Step 4: Run `node --test test/summary.test.js`.** Expect every Task 1 assertion to pass.
- [ ] **Step 5: Commit.** Stage the two Task 1 files and commit `feat: summarize dependency requirements`.

### Task 2: Extract selected upstream graphs

**Files:** Create `tools/npm-dep-paths/src/upstream.js`, `tools/npm-dep-paths/test/upstream.test.js`.

**Interfaces:** `collectUpstream(graph, result: Result, dependent: {kind:'exact', name, version}, from?: {kind:'exact', name, version}) -> Upstream`, with `Upstream` shaped as `{ selectedDependent, rootLocation:'', selectedLocations, targetLocations, topLevelLocations, nodes:[{location,name,version}], edges:[{from,to,requestedName,type,spec}] }`. Derive qualifying direct-dependent links from Task 1's result; do not re-enumerate routes.

- [ ] **Step 1: Write failing tests in `test/upstream.test.js`.** A convergent fixture returns each shared node and edge once, includes final dependent-to-target links, retains exact edge specs and types, and lists top-level locations. Two physical copies of the selected dependent both appear. `--from` keeps only a matching root child and its path to the selected dependent, while `result` remains outside this function and unchanged. A root dependent has no top-level locations. A cycle is represented by a finite edge list. Missing direct dependent and unrelated `from` selectors throw specific errors.
- [ ] **Step 2: Run `node --test test/upstream.test.js`.** Expect an import failure because `upstream.js` does not exist.
- [ ] **Step 3: Implement `collectUpstream` in `src/upstream.js`.** Build reverse edges, find selected-dependent ancestors, intersect with nodes reachable from root (or chosen top-level edge), then keep connecting graph edges and qualifying final target links. Deduplicate by full edge identity and sort every location and edge list. For `from`, include root and only matching direct root edge(s); reject a choice that cannot reach a selected dependent. Do not recursively expand shared nodes or cycles.
- [ ] **Step 4: Run `node --test test/upstream.test.js`.** Expect every Task 2 assertion to pass.
- [ ] **Step 5: Commit.** Stage the two Task 2 files and commit `feat: extract upstream dependency graph`.

### Task 3: Render schema v2 and the upstream views

**Files:** Create `tools/npm-dep-paths/src/report.js`, `tools/npm-dep-paths/test/report.test.js`.

**Interfaces:** `renderSummaryText(project, results: Result[]) -> string`; `renderSummaryJson(project, selector, results: Result[], upstream?: Upstream) -> string`; `renderUpstreamText(project, result: Result, upstream: Upstream, from?: {name,version}) -> string`. All return one final newline. Task 4 composes summary and upstream text and uses the single JSON renderer.

- [ ] **Step 1: Write failing tests in `test/report.test.js`.** Assert the declared requirement appears before grouped direct dependents in text; distinguish identical labels at different locations; show dependency type and alias requested name; order versions/groups/dependents deterministically. Parse normal JSON and assert `schemaVersion: 2`, exact `result` versus name-only `results`, two-key requirement groups, and no `upstream`, `routes`, or `routeCount`. Parse detailed JSON and assert the same summary plus complete `upstream`, including `from` filtering without summary changes. Assert overview text lists all immediate parents and top-level entries with graph counts; focused text shows every connecting edge, one reference for a shared node, and no recursive cycle expansion. Verify control/non-ASCII specs round-trip in JSON and are escaped in text.
- [ ] **Step 2: Run `node --test test/report.test.js`.** Expect an import failure because `report.js` does not exist.
- [ ] **Step 3: Implement the three renderers in `src/report.js`.** JSON preserves the exact field names and shapes in the spec. Text rendering uses iterative traversal and reference markers for repeated installed locations; it never silently truncates a parent, top-level, or edge list. The empty result text remains `No matching installed packages.`.
- [ ] **Step 4: Run `node --test test/report.test.js`.** Expect every Task 3 assertion to pass.
- [ ] **Step 5: Commit.** Stage the two Task 3 files and commit `feat: render compact dependency reports`.

### Task 4: Switch the CLI and documentation to the final contract

**Files:** Create `tools/npm-dep-paths/src/selector.js` and `tools/npm-dep-paths/test/selector.test.js`; modify `tools/npm-dep-paths/src/cli.js`, `tools/npm-dep-paths/test/cli.test.js`, `tools/npm-dep-paths/README.md`, and root `README.md`; remove `tools/npm-dep-paths/src/routes.js`, `tools/npm-dep-paths/src/render.js`, `tools/npm-dep-paths/test/routes.test.js`, and `tools/npm-dep-paths/test/render.test.js` after their still-relevant coverage is carried into the new tests.

**Interfaces:** `parseSelector(input: string) -> {kind:'name'|'exact',name,version?}` moves unchanged to `selector.js`. `main(argv, io = process, deps = defaults) -> Promise<number>` uses Tasks 1–3 and writes once after all parsing, graph work, filtering, and rendering succeed.

- [ ] **Step 1: Update `test/cli.test.js` and add `test/selector.test.js` with failing integration assertions.** Name-only and exact queries emit schema v2 summaries; `--upstream-of` with `--format json` adds the complete graph; `--from` filters only the graph; text overview and focused graph display; `--help` lists both flags. Invalid selectors, `--from` alone, name-only target plus `--upstream-of`, non-direct dependent, unrelated top-level selector, and unsupported format exit 1 with no stdout. Port scoped-name, exact-version, and range-rejection selector checks from the old route tests. A large convergent fixture's CLI output is compact and complete without a subprocess output-buffer limit.
- [ ] **Step 2: Run `node --test test/cli.test.js test/selector.test.js`.** Expect failures against the old route-array output, unknown flags, and missing selector module.
- [ ] **Step 3: Move `parseSelector` to `selector.js` and switch `main` to `collectSummaryResults`, optional `collectUpstream`, and the new renderers.** Parse both flags as exact selectors; validate their combination before loading the project. Preserve one write to stdout only after success. Remove the superseded modules and tests after migrating their relevant selector, deep-graph, and error coverage. Update the tool README with commands and schema v2 examples; update the root index if its description still promises route arrays.
- [ ] **Step 4: Run `npm test`, `node bin/npm-dep-paths.js --help`, and `git diff --check`.** Expect the full suite to pass, help to show the final command, and no whitespace errors. Confirm `git diff --name-only` contains no `tools/npm-dep-audit/` file.
- [ ] **Step 5: Commit.** Stage only the Task 4 files and commit `feat: expose compact npm-dep-paths output`.

## Final verification and handoff

- Run the exact-version and name-only CLI forms against a small fixture; confirm exact returns one result and name-only returns every reachable installed version.
- Use `/home/maw/src/nrc/npm-dep-flow-impl/tmp/xxx-webapp-brace-expansion.json` as a read-only reference for the expected three versions and distinct raw requirements; the CLI target must be a directory with a manifest and lockfile, not that JSON file.
- Run `npm test` from `tools/npm-dep-paths/`, inspect its final pass/fail count, run `git diff --check`, and confirm the worktree is clean after commits.
- Confirm the branch retains only `docs/superpowers/specs/2026-10-13-npm-dep-paths-design.md` and `docs/superpowers/plans/2026-10-13-npm-dep-paths.md` for this tool, with no `npm-dep-audit` changes.
