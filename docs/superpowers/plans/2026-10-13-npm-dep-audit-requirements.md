# npm-dep-audit Requirements Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace npm-dep-audit's installed paths output with declared requirements and direct dependents provided by the standalone npm-dep-paths CLI.

**Architecture:** After audit findings are grouped and severity-filtered, invoke `npm-dep-paths` from `PATH` once for each distinct affected package name. Validate its schema version 2 JSON, match exact versions, and keep only links to locations npm audit reported. Render Markdown and audit JSON from those filtered requirement groups; leave the audit cache independent of dependency-path data.

**Tech Stack:** Node.js 20+, ES modules, `node:test`, npm CLI subprocesses, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md`

## Global Constraints

- Support ordinary npm projects with `package-lock.json` lockfile versions 2 and 3; reject workspaces and local `file:` or linked packages.
- Install `npm-dep-paths` as a separate CLI and invoke its documented JSON interface from `PATH`; do not import its private source.
- Invoke `npm-dep-paths` once per distinct package name among kept audit rows; a name-only query returns all installed versions.
- Match exact package name, version, and affected lockfile locations; fail when any affected location has no qualifying dependency link.
- Audit JSON uses `schemaVersion: 2` and replaces each row's `paths` with `requirements`.
- A required `npm-dep-paths` failure exits nonzero, writes to stderr, and emits no partial stdout.
- Never install dependencies or run lifecycle scripts in the checked project.
- The repository root remains documentation-only; run package commands inside the relevant tool directory.

## File map

- `tools/npm-dep-audit/src/dep-paths.js`: locate and run the standalone CLI; validate its versioned JSON.
- `tools/npm-dep-audit/src/requirements.js`: join path summaries to audit rows and filter links to affected locations.
- `tools/npm-dep-audit/src/cli.js`: orchestrate calls after severity filtering and before rendering.
- `tools/npm-dep-audit/src/render.js`: display requirement groups and emit audit JSON schema version 2.
- `tools/npm-dep-audit/test/dep-paths.test.js`, `requirements.test.js`, `cli.test.js`, `render.test.js`, and `dep-paths.integration.test.js`: subprocess, join, orchestration, output, and real CLI boundary coverage.
- `tools/npm-dep-audit/README.md`, `tools/npm-dep-paths/README.md`, and root `README.md`: document separate CLI installation and the audit-to-detail workflow.
- `.github/workflows/npm-dep-audit.yml`: install both CLIs independently and run unit plus real CLI integration tests on Unix-like and Windows runners.
- `docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md`: approved design; update only if implementation reveals a required correction.

## Review Focus

- A missing CLI, nonzero exit, or malformed JSON must not produce partial audit output; Task 1 tests adapter errors and Task 3 tests stdout remains empty.
- Project paths with spaces or shell metacharacters must remain safe on Windows; Task 1 passes the path only through `cwd` and tests the Win32 invocation.
- Multiple installed copies of one vulnerable version may not all be affected; Task 2 filters exact `targetLocation` values and checks every affected location is represented.
- A name-only response can include harmless versions of the same package; Task 2 maps only exact vulnerable versions and preserves separate version rows.
- Scoped names and npm aliases must retain resolved identity and requested alias; Task 1 tests scoped selectors and rejects invalid shell tokens, while Task 2 tests `requestedName` preservation.

---

### Task 1: Run and validate the npm-dep-paths CLI

**Files:** Create `tools/npm-dep-audit/src/dep-paths.js` and `tools/npm-dep-audit/test/dep-paths.test.js`.

**Interfaces:** Export `runNpmDepPaths(projectRoot, packageName, spawnImpl = spawn, platform = process.platform) -> Promise<PathSummaryEnvelope>`. It invokes `npm-dep-paths <project> <packageName> --format json` from `PATH`, returns parsed JSON, and rejects with an actionable error when execution or validation fails. The project argument is `.` and `cwd` is `projectRoot`, keeping arbitrary filesystem paths out of shell command text.

- [ ] **Step 1: Write failing adapter tests.** Test Unix invocation uses executable `npm-dep-paths`, args `['.', 'brace-expansion', '--format', 'json']`, `cwd` equal to a project path containing spaces and shell characters, and `shell: false`. Test Win32 invocation uses `npm-dep-paths.cmd` with the same selector arguments, `cwd` set to the same path, and `shell: true`; assert that path never appears in the shell command. Test successful schema version 2 name-only JSON, scoped package names, rejection of a selector containing shell metacharacters before spawn, missing executable, nonzero exit including stderr, invalid JSON, wrong schema version, wrong selector, and malformed result/link fields.
- [ ] **Step 2: Run the focused test.** From `tools/npm-dep-audit/`, run `node --test test/dep-paths.test.js`. Expect failures because the adapter does not exist.
- [ ] **Step 3: Implement `runNpmDepPaths`.** Capture complete stdout and stderr, parse JSON only after exit code zero, validate `schemaVersion === 2`, the expected name-only selector, `results`, each requirement's string `declaredRequirement` and `directDependents` array, and every dependent's `name`, `version`, `location`, `targetLocation`, `type`, and `requestedName` strings. Validate the package name before placing it in a command. For Win32, invoke the `.cmd` shim through the shell; package names come from validated npm lockfile identities, and the target project path is supplied only as `cwd`.
- [ ] **Step 4: Run the focused test.** Run `node --test test/dep-paths.test.js`; expect all adapter tests to pass.
- [ ] **Step 5: Commit.** Commit `src/dep-paths.js` and `test/dep-paths.test.js` as `feat: invoke npm-dep-paths from audit`.

### Task 2: Join requirement groups to vulnerable audit rows

**Files:** Create `tools/npm-dep-audit/src/requirements.js` and `tools/npm-dep-audit/test/requirements.test.js`.

**Interfaces:** Export `attachRequirements(rows, summariesByPackage) -> EnrichedRow[]`. Each enriched row retains `paths` internally for matching and adds `requirements`; renderers consume the requirements and do not expose the internal paths.

- [ ] **Step 1: Write failing join tests.** Cover a package with vulnerable versions `2.1.7` and `5.0.9` where the CLI response also contains a harmless version. Assert only exact matching versions attach. For a version with two affected paths and one non-affected installation of that same version, assert only dependent links whose `targetLocation` is in `row.paths` remain. Assert distinct declared requirements remain separate, each affected path is represented, repeated physical links remain distinct in JSON data, and an npm alias retains its `requestedName` while matching the resolved package name. Assert missing version results, missing affected-location links, and absent package summaries reject.
- [ ] **Step 2: Run the focused test.** Run `node --test test/requirements.test.js`; expect failures because the join module does not exist.
- [ ] **Step 3: Implement `attachRequirements`.** Index name-only results by exact package name and version. Filter each requirement group's direct dependents by the row's affected `paths`, omit empty groups, preserve the CLI's deterministic requirement and link order, and fail if any affected path has no incoming link in the filtered groups.
- [ ] **Step 4: Run the focused test.** Run `node --test test/requirements.test.js`; expect all join tests to pass.
- [ ] **Step 5: Commit.** Commit the new module and test as `feat: attach declared requirements to audit rows`.

### Task 3: Integrate the CLI and update report formats

**Files:** Modify `tools/npm-dep-audit/src/cli.js`, `tools/npm-dep-audit/src/render.js`, `tools/npm-dep-audit/test/cli.test.js`, and `tools/npm-dep-audit/test/render.test.js`; create `tools/npm-dep-audit/test/dep-paths.integration.test.js`.

**Interfaces:** The CLI injects `runNpmDepPaths` alongside existing dependencies. It calls the adapter once for each distinct package name among severity-filtered rows, builds a `Map<string, PathSummaryEnvelope>`, and passes it to `attachRequirements`. No rows means no path CLI calls. Renderers accept enriched rows; JSON emits schema version 2.

- [ ] **Step 1: Write failing orchestration and integration tests.** Using injected dependencies, assert one invocation per distinct kept package name, a single name-only query can enrich multiple version rows, severity-filtered rows cause no calls, an empty report causes no calls, cached audits still obtain fresh requirement data, and any subprocess or join failure returns 1 with empty stdout and an error on stderr. Also create a temporary-project integration test that calls `main` with a fake audit response and the real `runNpmDepPaths`; assert the final Markdown and JSON include the fixture requirement. Skip this integration test unless `NPM_DEP_PATHS_INTEGRATION=1`.
- [ ] **Step 2: Write failing renderer tests.** Assert the Markdown column is `Declared requirements`, each declared requirement precedes its dependents on separate `<br>` lines, dependency type and alias appear, duplicate visible dependents include installation counts, requirement text and labels are escaped, and empty findings retain the existing empty-report message. Parse JSON and assert `schemaVersion === 2`, rows contain `requirements`, and no row contains `paths`; check all requirement and dependent field names match the paths CLI contract.
- [ ] **Step 3: Run focused tests.** Run `node --test test/cli.test.js test/render.test.js`; expect failures against the current orchestration and output. The integration test remains skipped unless enabled after the standalone CLI is installed.
- [ ] **Step 4: Implement orchestration and rendering.** Enrich rows after severity filtering and before writing stdout. Render only after all package summaries are complete. Format each Markdown group as `<declaredRequirement> → <dependent labels>` and include repeated installation counts; construct JSON rows explicitly so internal `paths` cannot leak.
- [ ] **Step 5: Run the full audit suite.** Run `npm test` from `tools/npm-dep-audit/`; expect all tests to pass.
- [ ] **Step 6: Commit.** Commit the CLI, renderer, and tests as `feat: report audit dependency requirements`.

### Task 4: Document standalone installation and verify both CLIs in CI

**Files:** Modify root `README.md`, `tools/npm-dep-audit/README.md`, `tools/npm-dep-paths/README.md`, and `.github/workflows/npm-dep-audit.yml`.

**Interfaces:** The audit README explains that `npm-dep-paths` must be installed separately and available on `PATH`; the paths README documents standalone installation and points audit users to the integration; the root index describes both tools and links their READMEs. The integration test calls `main` with a fixture audit response and the real default `runNpmDepPaths`, asserting the final report contains the fixture's declared requirement. CI installs the paths CLI from its own package directory as a global executable, independently installs the audit tool dependencies, enables the integration test, then runs the suite on Ubuntu and Windows.

- [ ] **Step 1: Run the integration test against a standalone CLI.** Install `npm-dep-paths` from `tools/npm-dep-paths/` with `npm install --global . --ignore-scripts`, set `NPM_DEP_PATHS_INTEGRATION=1`, and run `node --test test/dep-paths.integration.test.js` from `tools/npm-dep-audit/`. Expect the real child process to produce the fixture's requirement in both report formats.
- [ ] **Step 2: Update documentation.** Add standalone installation instructions for `npm-dep-paths`, explain the separate CLI dependency and `npm-dep-paths` schema version 2 consumption, document the new Markdown column and audit JSON version 2, and show an `--upstream-of` command for route detail. Update root tool descriptions and links.
- [ ] **Step 3: Update audit CI.** Add Ubuntu and Windows runners. In each job, install `npm-dep-paths` globally from `../npm-dep-paths` with lifecycle scripts disabled, install audit dependencies with `npm ci --ignore-scripts`, set `NPM_DEP_PATHS_INTEGRATION=1`, and run `npm test` from `tools/npm-dep-audit/`.
- [ ] **Step 4: Review docs and workflow.** Check links, commands, and schema references; run `git diff --check` and confirm no stale audit README statement says JSON schema 1 or `paths` is public output.
- [ ] **Step 5: Commit.** Commit docs and workflow as `docs: explain npm-dep-audit paths integration`.

## Final verification

- [ ] Run `npm test` from both `tools/npm-dep-audit/` and `tools/npm-dep-paths/`.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Install `npm-dep-paths` as a standalone CLI and run `npm-dep-audit` against a controlled fixture; inspect Markdown and JSON results.
- [ ] Confirm the audit JSON contains `schemaVersion: 2`, grouped requirements, and no public `paths` field.
- [ ] Confirm `npm-dep-audit` exits nonzero with no stdout when the paths executable is unavailable or returns invalid data.
- [ ] Confirm the checked project's manifest and lockfile remain unchanged.
