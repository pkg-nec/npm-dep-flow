# npm-dep-paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone CLI that reports every logical route to an installed npm package version, with each dependent's declared spec on the route.

**Architecture:** Load the target manifest and lockfile, resolve their declarations into a graph keyed by lockfile location, then enumerate simple root-to-target routes without global deduplication. Group routes by exact resolved version and render complete text trees or versioned JSON after validating the reachable graph.

**Tech Stack:** Node.js 20+ ES modules, `node:test`, npm `semver` package; no npm subprocess or Arborist at runtime.

**Spec:** `docs/superpowers/specs/2026-10-13-npm-dep-paths-design.md`

## Global Constraints

- Work only in the new `tools/npm-dep-paths/` package, its root README index entry, and this plan's tracking state. Do not modify `tools/npm-dep-audit/`.
- Any temporary files go under `/home/maw/src/nrc/npm-dep-flow-impl/tmp`; any new worktree goes under `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`.
- Support ordinary single-package npm projects with `package-lock.json` versions 2 and 3; reject workspaces, local `file:` or linked packages, shrinkwrap files, and other package managers.
- Read the target project's manifest and lockfile only; never install into it, change it, run lifecycle scripts, or require its `node_modules`.
- CLI: `npm-dep-paths <project> <package-selector> [--format text|json]`; text is default. Name-only selects all reachable versions; `name@exact-version` selects one.
- JSON has `schemaVersion: 1`, `project: { name, version }`, `selector`, and either `result` for exact selection or `results` for name-only selection. Each item has `package`, `version`, `routeCount`, `routes`; each node has `name`, `version`, `location`, `incoming` (`null` at root, otherwise `{ name, type, spec }`).
- Keep all distinct root-to-target edge sequences. Skip absent optional and optional peer edges. Fail on an unresolved required edge and emit no partial stdout. Do not impose a depth, route, or output-size limit.
- Install this tool's own dependencies with `--ignore-scripts`. Use `npm test` from `tools/npm-dep-paths/` for the final suite.

## File map

- `tools/npm-dep-paths/package.json`, `package-lock.json`: independent ESM package, CLI bin, `node --test`, `semver` dependency.
- `tools/npm-dep-paths/src/project.js`: read and validate target files and unsupported project forms.
- `tools/npm-dep-paths/src/graph.js`: resolve declared edges to lockfile locations and validate the root-reachable graph.
- `tools/npm-dep-paths/src/routes.js`: parse selectors, enumerate all simple routes, group and order version results.
- `tools/npm-dep-paths/src/render.js`: complete text trees and versioned JSON envelopes.
- `tools/npm-dep-paths/src/cli.js`, `bin/npm-dep-paths.js`: argument parsing, orchestration, exit and output behavior.
- `tools/npm-dep-paths/test/*.test.js`: focused fixtures and CLI integration checks.
- `tools/npm-dep-paths/README.md`, root `README.md`: public usage and tool index.

## Review Focus

- A scoped alias can use a scoped requested name and a different resolved name: Task 2 tests both identities and Task 3 tests selection by resolved name.
- A package lists one name under both `dependencies` and `optionalDependencies`: Task 2 tests npm's optional declaration precedence so an absent optional edge does not fail.
- An override makes the installed version differ from the dependent's declared range: Task 2 tests that the raw spec remains visible and the resolved version remains authoritative.
- The manifest and lockfile root declarations disagree: Task 1 tests a clear stale-lock error rather than constructing a misleading graph.
- A tree has more routes than a small subprocess buffer would hold: Task 3 tests the full count and Task 5 tests full CLI output without buffered subprocess capture.

---

### Task 1: Load and validate project inputs

**Files:** Create `tools/npm-dep-paths/package.json`, `package-lock.json`, `src/project.js`, `test/project.test.js`.

**Interfaces:** Produce `loadProject(path: string) -> Promise<{ root: string, manifest: object, lock: object }>`; `root` is canonical. Later tasks consume `manifest` and `lock` without rereading target files.

- [ ] **Step 1: Write failing tests.** In `test/project.test.js`, a minimal v2 and v3 project load with their root names and versions; missing or malformed files, lockfile v1, absent root name/version, workspaces, local/link references, shrinkwrap, and a root declaration mismatched between manifest and lock each reject with an input-specific message.
- [ ] **Step 2: Run `node --test test/project.test.js` from `tools/npm-dep-paths/`.** Expect failure because `src/project.js` is absent.
- [ ] **Step 3: Implement `loadProject(path)` and the package scaffold.** Validate object shapes and declaration fields across root and lock entries; reject unsupported forms before graph work. Add the ESM bin mapping and `node --test` script. Install the tool's `semver` dependency with `npm install --ignore-scripts --save semver` in this tool's directory.
- [ ] **Step 4: Run `npm test`.** Expect Task 1 tests to pass.
- [ ] **Step 5: Commit.** Stage the four Task 1 files and commit `feat: load npm dependency path inputs`.

### Task 2: Resolve the logical dependency graph

**Files:** Create `tools/npm-dep-paths/src/graph.js`, `test/graph.test.js`.

**Interfaces:** Consume the Task 1 project. Produce `buildGraph(project: { manifest, lock }) -> Map<string, GraphNode>` keyed by lockfile location, including `''` for root. `GraphNode` has `{ name, version, location, edges }`; each resolved edge has `{ name, type, spec, toLocation }`. `type` is one of the source declaration fields: `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`.

- [ ] **Step 1: Write failing tests.** A v3 fixture resolves nested and hoisted packages; two parents pointing to one hoisted node retain two edges; peer lookup reaches an ancestor installation; a scoped alias retains requested and resolved names; a present override target keeps the parent's raw, out-of-range spec. Test the Review Focus duplicate optional declaration, absent optional and optional peer, missing required dependency with declaring package in the error, and present malformed optional destination. Repeat a representative resolution on a v2 fixture.
- [ ] **Step 2: Run `node --test test/graph.test.js`.** Expect failure because `src/graph.js` is absent.
- [ ] **Step 3: Implement `buildGraph(project)` in `src/graph.js`.** For ordinary declarations, search `node_modules/<requested-name>` beneath the declaring location, then at each ancestor package location, up to root; for peers, start at the declaring package's parent. Use lockfile entry `name` for resolved identity when present. Validate all required edges reachable from root; omit only absent optional edges and optional peers. Do not reject an override merely because resolved version is outside the raw spec.
- [ ] **Step 4: Run `npm test`.** Expect Tasks 1–2 tests to pass.
- [ ] **Step 5: Commit.** Stage Task 2 files and commit `feat: resolve npm dependency graph`.

### Task 3: Select versions and enumerate every route

**Files:** Create `tools/npm-dep-paths/src/routes.js`, `test/routes.test.js`.

**Interfaces:** Produce `parseSelector(input: string) -> { kind: 'name'|'exact', name: string, version?: string }` and `collectResults(graph: Map<string, GraphNode>, selector) -> Result[]`. A `Result` is `{ package, version, routeCount, routes }`; each route is an ordered array of `{ name, version, location, incoming }`, where `incoming` is `null` or `{ name, type, spec }`.

- [ ] **Step 1: Write failing tests.** Parse scoped and unscoped names and exact versions; reject ranges and invalid selectors. Query one name with three versions and assert three ordered items; query one exact version and assert one item containing two different routes to the same installation. Assert selection uses the resolved name for aliases, path-specific cycle detection retains other routes, an absent exact version errors, an absent name returns `[]`, and a generated fixture with over 1,000 converging routes returns the exact full count.
- [ ] **Step 2: Run `node --test test/routes.test.js`.** Expect failure because `src/routes.js` is absent.
- [ ] **Step 3: Implement `parseSelector` and `collectResults` in `src/routes.js`.** Use `semver.valid` for exact versions and `semver.compare` for item order. Enumerate routes with an explicit traversal stack and a visited-location set local to each route; never use a global visited set. Sort routes by requested names, resolved versions, and locations.
- [ ] **Step 4: Run `npm test`.** Expect Tasks 1–3 tests to pass.
- [ ] **Step 5: Commit.** Stage Task 3 files and commit `feat: enumerate exact-version dependency routes`.

### Task 4: Render complete text and JSON reports

**Files:** Create `tools/npm-dep-paths/src/render.js`, `test/render.test.js`.

**Interfaces:** Produce `renderText(project: { manifest }, results: Result[]) -> string` and `renderJson(project: { manifest }, selector, results: Result[]) -> string`. Exact JSON uses `result: results[0]`; name-only JSON uses `results`. Both end with one newline.

- [ ] **Step 1: Write failing tests.** Assert two routes to one hoisted installation both appear in an `npm ls` style tree with `[dependency: ^5.0.5]` and `[dependency: 5.0.9]` on the correct leaves; common prefixes merge without losing distinct edges. Assert a name query produces separate version sections and a no-match message. Parse JSON and assert the exact versus name envelope, `schemaVersion: 1`, every route node's location and incoming declaration, and a root `incoming: null`. Include names/specs containing tree or JSON metacharacters.
- [ ] **Step 2: Run `node --test test/render.test.js`.** Expect failure because `src/render.js` is absent.
- [ ] **Step 3: Implement `renderText` and `renderJson` in `src/render.js`.** Build a display trie keyed by location plus incoming edge identity; draw branch characters only after inserting every route. Map declaration fields to readable singular text labels while preserving original field names in JSON. Do not truncate or abbreviate paths.
- [ ] **Step 4: Run `npm test`.** Expect Tasks 1–4 tests to pass.
- [ ] **Step 5: Commit.** Stage Task 4 files and commit `feat: render dependency route reports`.

### Task 5: CLI, integration checks, and documentation

**Files:** Create `tools/npm-dep-paths/src/cli.js`, `bin/npm-dep-paths.js`, `test/cli.test.js`, `README.md`; modify root `README.md`.

**Interfaces:** Produce `main(argv: string[], io = process, deps = { loadProject, buildGraph, parseSelector, collectResults, renderText, renderJson }) -> Promise<number>`; the bin sets `process.exitCode` from `main`. All graph validation and result collection finish before `io.stdout.write`.

- [ ] **Step 1: Write failing tests.** Assert default text and `--format json` output for name and exact selectors, `--help`, missing arguments, unknown flags, invalid format, no-match behavior, and no stdout after any error. Invoke the real bin against a fixture without `node_modules`, read stdout as a stream, and assert its route count and final route are intact for the large fixture. Compare representative route membership against `npm ls --package-lock-only` as a verification check, accounting for npm's own display choices.
- [ ] **Step 2: Run `node --test test/cli.test.js`.** Expect failure because CLI files are absent.
- [ ] **Step 3: Implement `main` and the executable; write docs.** Resolve arguments, call Tasks 1–4 in order, write only the completed report, and send errors to stderr with exit 1. Document installation, selectors, exact and name JSON shapes, optional omissions, failures, and unsupported project forms in the tool README; add the tool to the root README index.
- [ ] **Step 4: Run `npm test`, `node bin/npm-dep-paths.js --help`, and `git diff --check`.** Expect all tests pass, help lists the agreed command, and no whitespace errors.
- [ ] **Step 5: Commit.** Stage Task 5 files and commit `feat: expose npm-dep-paths CLI`.

## Final verification

- Run `npm test` from `tools/npm-dep-paths/` and inspect the final counts and failure total.
- Run the exact and name-only CLI forms against a small fixture and inspect that the former emits one version item while the latter emits all installed versions.
- Run `git status --short` and confirm `tools/npm-dep-audit/` has no changes.
