# Parent Dependency Upgrades PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-level parent upgrades to PR 1's remediation action set, executing parents first and committing each actual upgrade separately.

**Architecture:** Discover unresolved consumer branches through public paths graphs, search ancestors breadth-first up to two levels, and stop climbing a branch at its first executable suitable candidate. Extend PR 1's read-only resolver worker (planner) and strict transaction worker (upgrader) to handle ancestor closures, removed consumers and skipped actions.

**Tech Stack:** Node.js ESM tools, npm's Arborist resolver loaded from the selected npm, node:test, semver, public paths/versions CLI adapters, Git, existing real-npm local-registry harness.

**Spec:** [Approved design](../specs/2026-10-23-partial-and-parent-upgrades-design.md). **Dependency:** PR 1 ([plan](2026-10-23-partial-remediation-pr1.md)) and the `--clear-cache` change (PR #23, [plan](2026-10-26-clear-cache.md)), both merged.

**Revision (2026-10-26):** rechecked against `main` at `8274fee`. The original plan assumed pre-PR 1 code. This revision changes only what the current code requires; every spec requirement still maps to a task. Changes: validator and strategy handling (Task 3), removed-consumer coverage and isolation guards (Task 2/4), skip-capable executor and parent candidate selection (Task 4), the real executor file set, discovery placement in the planner CLI, executor result contract, clear-cache and CI constraints, release versions, and removal of the separate manifest-metadata module.

## Baseline in current main (read before Task 1)

- Planner `src/cli.js` runs audit, then one catalog per audited package (`runNpmDepVersions`), then synchronous `evaluateFindings(rows, versionsByPackage)` (within-range coverage only), then calls `deps.resolveChoices(project, row, choices, options)` **only** when a finding is `partial` or has more than one choice. A `none` finding never reaches the resolver today.
- `resolveChoices` writes private copies of `package.json`/`package-lock.json`, runs `src/resolver-worker.js` (Arborist `loadVirtual`/`buildIdealTree` from the selected npm) and returns `{schemaVersion:1, choices, graph, before, snapshots, coverage:{resolution,clearedConsumers,remainingConsumers}, freshAt}`.
- Worker guards that assume a within-range change to the *target package only*: `verifyResolution` ("Unrelated parent installation changed", "Original consumer requirement not satisfied", "Consumer resolved outside intended scope") and `matchesSelectedScope`. The coverage loop treats a consumer edge that no longer exists as **remaining**, and the executor's `verifyCoverage` (`src/coverage.js`) **throws** for it. Both contradict the spec rule that removing a dependency clears its branch.
- Upgrader `src/planner.js` `validatePlanner` requires every choice to have `targetPackage === row.package`, `targetLocation === row.targetLocation`, `currentVersion === row.version` and `targetVersion > row.version`; `selectItem` rejects any strategy other than `STRATEGY` (`src/model.js`).
- Upgrader `src/transaction.js` `executeActions` reads one catalog (the vulnerable package), selects each candidate with `selectCandidate`, runs the strict `src/resolver-worker.js` (its own copy), and fails unless `snapshots.length === choices.length`. Snapshots map to actions by `choiceIndex`; `commitSnapshots` (`src/commit-sequence.js`) already commits per snapshot and updates the Git guard after each commit. The result JSON is schema 3 with `actions` (each `outcome: 'applied'`) and `commits`.
- Upgrader `src/evidence.js` already consumes `npm-dep-paths <target@ver> --upstream-of <parent@ver> --format json` per immediate parent and validates it against the lockfile graph. One such call returns the whole upward graph (all ancestors and their declared specs), so two ancestor levels need no extra paths calls.
- `src/mutation.js`, `src/scopes.js` and `verifyGraph` in `src/verify.js` are no longer used by the main flow; do not extend them.
- Sibling CLIs on `PATH` are the globally linked **main checkout** tools. `bin/` directories contain only `.js` files, so prepending them does not select this checkout. Integration tests must create PATH shims to this checkout's `bin/*.js` as `tools/npm-dep-upgrade-plan/test/clear-cache.integration.test.js` does. The planner CI workflow installs only audit and versions globally and paths dependencies locally.
- Versions on main: paths 0.7.0, versions 0.2.0, audit 0.5.0, planner 0.8.0, upgrader 0.5.0.

## Global Constraints

- Maximum ancestor depth is exactly 2: immediate parent, then grandparent. The project root is not an upgradable package.
- Stop climbing each unresolved branch at its first suitable level. Do not expose ancestor search status or add a depth flag.
- Parent upgrades satisfy every incoming declared requirement, introduce no new override entries, and use npm-produced synchronized dependency files. Never patch `package-lock.json`.
- One finding ID remains package + installation location; resolutions/strategies do not split findings.
- JSON choices form one compatible action set. No choice IDs, selection flag, competing alternatives, or completeResolutionOptions.
- Removing a dependency clears its branch; relocating or replacing with another affected version does not.
- Execute parent actions before residual within-range actions; skip work already satisfied. Verify the whole transaction before committing and create one commit per actual upgrade.
- Retain planner schema 3 if its contract is sufficient (Task 3 decides with evidence); schema 4 only for a necessary incompatible change, updating the executor simultaneously. No older-schema migration logic.
- Preserve PR 1's runtime floors, independent CLI boundaries, security/configuration/cache rules, 7-day release age, scripts-disabled installs, error contracts, and Git ownership/concurrency guards.
- **Clear-cache (PR #23):** every new planner subprocess adapter (paths) forwards `--no-cache`, `--cache-ttl` where supported, and `--clear-cache` exactly like the audit/versions adapters (`...clearControl`, absent when not requested). Any new persistent planner cache lives under `XDG_CACHE_HOME/npm-dep-upgrade-plan` so `--clear-cache` removes it. Clear-only mode (no project argument) is unchanged.
- Subprocess launching stays portable (`.cmd` through a shell on Windows); test both argv forms for new adapters.
- Worktrees: `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`; task scratch: `/home/maw/src/nrc/npm-dep-flow-impl/tmp`.

## Review Focus

1. Immediate-parent success with a newer grandparent available: no grandparent candidate request is made for that resolved branch (Task 1).
2. Shared ancestor reached by several branches: deduplicate one upgrade and satisfy all its incoming ranges, including other consumers (Tasks 1, 2).
3. Parent drops A directly but reintroduces it through another descendant: do not claim that branch is safe (Task 2).
4. Parent removes A entirely: the branch counts as cleared in the planner, in the executor and in resolver verification, and is not treated as a failed or remaining consumer (Tasks 2, 4).
5. npm leaves C on vulnerable A after upgrading B to a safe exact pin: perform residual work instead of assuming deduplication (Task 4).
6. Second commit fails after a successful parent commit: preserve history and give exact remaining-state diagnostics (Tasks 4, 5).
7. A `none`-today finding (no within-range action) that a parent upgrade can fix is reported `partial`/`complete`, and a within-range-`complete` finding is never altered by parent discovery (Task 2).

## Files and responsibilities

Planner new modules: `src/paths.js` (public upstream graph adapter and validation), `src/ancestors.js` (bounded traversal and candidate search). No manifest-metadata module: suitability of descendants is decided by the resolver, and parent candidates come from the public versions CLI catalogs (dates and stable versions) plus incoming specs from the paths graph. New tests match module names.

Planner modified: `src/cli.js` (parent discovery after `evaluateFindings`, for `partial` and `none` findings; forward controls), `src/resolver-worker.js` and `src/resolver.js` (parent choices, removed consumers, generalized isolation), `src/report.js`, `src/versions.js` (reuse; ancestor catalogs deduplicated, concurrency ≤ 4), `README.md`. `src/evaluate.js` and `src/coverage.js` stay pure and synchronous.

Mutator modified: `src/planner.js` and `src/model.js` (strategy-aware validation), `src/transaction.js`, `src/resolver-worker.js`, `src/coverage.js`, `src/candidates.js` or a new `src/parent-candidates.js` (parent candidate selection), `src/cli.js`, `src/report.js`, `README.md`. Reuse `src/commit-sequence.js`, `src/git.js`, `src/recovery.js`. Do not touch `mutation.js`, `scopes.js`, `verify.js`.

E2E: add `test/e2e/parents.test.js` and fixtures; update `COVERAGE.md`, README docs. Package versions change only in the release commit.

## Interfaces inherited and added

Reuse PR 1 `consumerKey`, `selectWithinRangeChoices`, `resolveChoices`, `executeActions`, `commitSnapshots`, `verifyCoverage` shapes.

Parent choice (schema 3 shape): `{ strategy: 'upgrade-via-parent-dependency', targetPackage: <ancestor name>, targetLocation: <ancestor location>, currentVersion, targetVersion, affectedConsumers: [{location, requestedName, type}] }` where `affectedConsumers` are branches of the **original finding** (consumers of the vulnerable installation) that the ancestor upgrade covers.

`UpstreamGraph = {nodes: Map<location,{location,name,version}>, edges: {from,to,requestedName,type,spec}[]}`.

`readUpstream(projectRoot, target, parents, controls): Promise<UpstreamGraph>` runs `npm-dep-paths . <target@version> --upstream-of <parent@version> --format json` once per distinct immediate parent (name@version), merges the results, and validates schema version 2, node/edge shape, that every edge endpoint is a node, and that selected parents are direct dependents of the target. `controls = {noCache, clearCache}`.

`findParentChoices({row, targetLocation, unresolvedConsumers, graph, catalogs}): Choice[]` is a pure function over the validated graph and ancestor catalogs (`catalogs: Map<name,{versions, releaseTimes}>`). Candidate screening is by incoming specs only; descendant-closure suitability is decided in Task 2 by the resolver.

`applyParentChoice` is internal to the strict transaction worker: it applies npm's named update for the ancestor under the project's original declarations, never adds overrides, and reports `{outcome: 'applied' | 'already-satisfied', graph, files}`.

Executor result (schema 3, extended): each `actions[]` entry gains `outcome: 'applied' | 'skipped-already-satisfied'`; `commits[]` unchanged. Documented in Task 4/5; no legacy reader.

## Intended commit order

1. `feat(upgrade-plan): search two ancestor levels for remediation` — paths adapter, bounded search, catalog reuse, tests.
2. `feat(upgrade-plan): verify parent remediation action sets` — worker support for parent choices and removed consumers, no-override feasibility, combined coverage, CLI integration, cache freshness.
3. `feat(upgrade-plan): report parent upgrade transitions` — Markdown and parent choice validation in both tools. Use `!` and a breaking footer if schema 4 proves necessary.
4. `feat(upgrade): execute parent upgrades before residual updates` — skip-capable transaction, parent candidate selection, removed-consumer coverage, per-action commits, result contract.
5. `test: verify mixed parent remediation transactions` — E2E matrix and final docs.
6. `chore: release parent dependency upgrades` — grouped minor bumps relative to PR 2's actual base: planner 0.9.0, upgrader 0.6.0 if main is unchanged; paths 0.8.0 only if Task 1 needed a documented paths extension. Recheck bases at release time.

## Task 1: bounded graph discovery

**Files:** Create planner `src/paths.js`, `src/ancestors.js`, `test/paths.test.js`, `test/ancestors.test.js`; modify `src/cli.js` only for wiring in Task 2.

**Interfaces:** `readUpstream`, `findParentChoices`, `MAX_ANCESTOR_LEVELS = 2` (exported from `src/ancestors.js`).

- [ ] Write `stops after immediate-parent success`: B@1.0.1 → B@1.1.0 clears its A branch; assert only B's catalog candidates are evaluated and no grandparent package is queried.

```js
assert.equal(MAX_ANCESTOR_LEVELS, 2)
assert.equal(result[0].targetPackage, 'B')
assert.deepEqual(evaluatedPackages, ['B'])
assert.equal(grandparentLookups, 0)
```

- [ ] Write grandparent fallback, two-level failure with a safe level-3 ancestor ignored, independent B/D branches, shared-grandparent deduplication, root-stop (the project root is never a candidate), cycles, aliases (resolved name differs from requested name), and required incoming-range validation tests. Assert final choices contain no search fields and are deterministically ordered.
- [ ] Write `paths.test.js` for adapter argv on Unix and Windows (including `--no-cache` and `--clear-cache`), wrong schema, missing edges, alias identity, malformed nodes, repeated names at different locations, and multiple-parent graph merging.
- [ ] Run `node --test test/paths.test.js test/ancestors.test.js` and confirm failures.
- [ ] Implement a reverse adjacency index and breadth-first levels over unresolved branches. Prefer the lowest suitable newer stable catalog version and deterministic location ordering. Screening checks every incoming spec on the ancestor installation (from the graph), release dates and stable versions only. Do not enumerate root-to-target paths, evaluate level 3, or climb already-covered branches. Treat malformed or failed paths/catalog responses as errors.
- [ ] Run focused tests and shared lint; commit intended message 1.

## Task 2: combined resolution, removed consumers, and no-override feasibility

**Files:** Modify planner `src/resolver-worker.js`, `src/resolver.js`, `src/cli.js`; extend `test/resolver.test.js`, `test/resolver-isolation.test.js`, `test/resolver.integration.test.js`, `test/cli.test.js`, `test/result-cache.test.js`.

**Interfaces:** `resolveChoices` keeps its return shape; choices may include parent choices. `coverage.clearedConsumers` now includes consumers whose edge was removed.

- [ ] **Spike first (record the result as a ledger ruling):** determine with real npm 12.1.0 and 11.10.0 fixtures how to land an ancestor on a specific tested version through npm's named update without overrides or declaration edits. If no mechanism selects a version below the highest in-range release, the candidate is the version npm's named update actually produces. That would narrow the spec's "lowest suitable" preference to the producible versions and needs the user's confirmation before continuing.
- [ ] Write failing worker/unit cases: safe exact child replacement, direct removal (branch counts as cleared and the resolution is `complete`), indirect vulnerable reintroduction (`none`), unsafe replacement version, conflicting shared ancestors, unrelated target installations unchanged, parent candidates excluded by another incoming requirement.

```js
assert.equal(removalResult.coverage.resolution, 'complete')
assert.equal(reintroducedResult.coverage.resolution, 'none')
assert.deepEqual(afterManifest.overrides, beforeManifest.overrides)
```

- [ ] Generalize the worker: the cleared/remaining loop and `verifyResolution` treat a missing consumer edge as removed (cleared). Replace "Unrelated parent installation changed" and "Consumer resolved outside intended scope" with checks that allow changes inside the ancestor's resolved closure and the explicitly covered shared edges, while still rejecting changes to unrelated installations. Keep the within-range checks unchanged for within-range choices (existing tests stay green).
- [ ] Parent choices use npm's named update under original declarations. Require the actual resulting ancestor version and scope to match the tested candidate; if the update also changes unrelated copies and cannot be isolated, reject that candidate. Introduce no override entries and no lockfile edits; assert manifest and lockfile stay synchronized.
- [ ] Wire discovery in planner `cli.js`: after `evaluateFindings`, for each `partial` or `none` finding with uncovered consumers, call `readUpstream` (immediate parents come from the audit row's `directDependents`), fetch ancestor catalogs (deduplicated, concurrency ≤ 4, `noCache`/`ttl`/`clearCache` forwarded), run `findParentChoices`, then `resolveChoices` for the combined set. Final resolution comes from the jointly resolved graph; a within-range `complete` finding is not changed. Retain the feasible subset and report partial/none when valid constraints exclude the rest; reserve errors for resolver/network/malformed-data failures. Do not fabricate completeness by merging independent claims.
- [ ] Test freshness and caching: catalog, upstream graph and resolver evidence all bound result expiry (earliest source wins); `--no-cache` bypass and `--clear-cache` propagate to every new paths and versions call; the planner cache identity covers the action set and sibling versions as before.
- [ ] Run planner `npm test` with the integration environment using PATH shims to this checkout's executables, local-registry resolver tests with both npm runtimes, and shared lint; commit intended message 2.

## Task 3: parent choice reporting and schema decision

**Files:** Modify planner `src/report.js`, `test/report.test.js`, `test/cli.test.js`, `README.md`; mutator `src/planner.js`, `src/model.js`, `test/planner.test.js`, `README.md`; repository README as needed.

**Interfaces:** Reuse schema 3 `Choice` and `resolution/choices` if the parent choice shape above is sufficient.

- [ ] Write failing Markdown assertions for `Update within declared range` and `Upgrade via parent dependency: B@1.0.1 → B@1.1.0` in the same item. Test multiple parent transitions, scoped names, escaping, none/partial/complete, deterministic ordering, and unchanged finding IDs across strategy changes.

```js
assert.match(markdown, /Update within declared range/)
assert.doesNotMatch(markdown, /Update within declared range:/)
assert.match(markdown, /Upgrade via parent dependency: B@1\.0\.1 → B@1\.1\.0/)
assert.equal(report.rows[0].id, originalFindingId)
```

- [ ] Make the executor's `validatePlanner` strategy-aware. Within-range choices keep every existing check. Parent choices require a valid ancestor name and canonical `targetLocation` (which may differ from the row's), `currentVersion` valid, `targetVersion` valid and greater than `currentVersion`, and non-empty unique `affectedConsumers` whose consumer locations are canonical. Remove the global `targetVersion > row.version` and `targetPackage === row.package` checks from the parent path only. In this commit `selectItem` still rejects the parent strategy at selection (Task 4 enables it), so the executor never accepts what it cannot yet run.
- [ ] Write executor validation tests: ancestor package differing from the vulnerable package, forged parent target outside two levels (validated against fresh evidence in Task 4), parent choice with incorrect covered consumers, and an unsupported strategy.
- [ ] Run planner report/CLI tests and mutator planner tests; confirm failures before implementation.
- [ ] Render the within-range label first and distinct parent transitions after it. Keep severity and safe-version columns and one row per installation.
- [ ] Record the schema decision in both READMEs: default is retaining 3. If implementation finds a required incompatible field, stop, document schema 4, update both producer/consumer tests and the cache identity together, and implement no migration reader.
- [ ] Run focused suites and shared lint; commit intended message 3, marking breaking only if necessary.

## Task 4: parent-first, skip-capable executor

**Files:** Modify mutator `src/transaction.js`, `src/resolver-worker.js`, `src/coverage.js`, `src/planner.js` (enable parent strategy in `selectItem`), `src/cli.js`, `src/report.js`, `src/candidates.js` (or new `src/parent-candidates.js`), corresponding unit tests, `test/commit-sequence.test.js`.

**Interfaces:** `executeActions` returns `{snapshots, actions, coverage}` where `actions` includes skipped entries (`outcome: 'skipped-already-satisfied'`) and `snapshots` contain only performed upgrades, each with `choiceIndex`. `commitSnapshots` is unchanged.

- [ ] Write B-safe-pin tests for both npm outcomes: C becomes safe and A is skipped, or C stays vulnerable and A executes. Assert one and two snapshots respectively, and that the result lists the skipped action.
- [ ] Write B-removes-A tests requiring a residual C upgrade and two snapshots, and verify remaining branch identities survive relocation. Add all-incoming-range, unchanged override policy, duplicate-parent-action, shared-copy scope rejection, and fresh-security tests.

```js
assert.deepEqual(performedPackages, ['B', 'A'])
assert.equal(result.snapshots.length, 2)
assert.equal(result.coverage.resolution, 'complete')
assert.deepEqual(commitSubjects, [
  'deps: bump B from 1.0.1 to 1.1.0',
  'deps: bump A from 1.2.3 to 1.2.5',
])
```

- [ ] Write parent candidate selection tests: the ancestor's own catalog is read; at least seven days of release age and the configured cutoff apply; the descendant closure is checked with fresh advisories (the ancestor itself need not be vulnerable); an alternate candidate must preserve the planned coverage and scope or the run fails with a stale-plan error.
- [ ] Write transaction validation tests: complete validation before any commit, one commit per performed upgrade, no commit for skipped actions, parent commit first, second-commit hook failure preserving the first commit and external edits.
- [ ] Run mutator focused transaction/coverage/commit tests and confirm failures before implementation.
- [ ] Implement: validate parent choices against fresh evidence (ancestor within two levels of the vulnerable installation through the loaded graph; covered consumers are real consumers; ancestor incoming specs still satisfied); order actions parents first (ancestor level ascending, then original location/name/version), then within-range; reload graph and reassess after each action; the strict worker returns `already-satisfied` instead of failing when an action's whole effect is present, and `transaction.js` replaces the "snapshots equal choices" guard with "every non-skipped choice has exactly one snapshot". Generalize `verifyCoverage` so a removed consumer edge is cleared, and every remaining consumer edge keeps the original-requirement check. Do not treat disappearance of an arbitrary location as remediation.
- [ ] Apply the same tested named-update operation used by planning without override entries; scope changes to the ancestor closure and explicitly covered shared edges; retain unrelated consumers and installations.
- [ ] Update the result contract and `report.js`: `actions[]` entries carry `outcome`; Markdown lists skipped actions without commits; document it in the README as an additive change to schema 3 (no legacy reader).
- [ ] Validate the final actual tree and fresh security, then invoke PR 1 snapshot commit sequencing. Preserve each action's npm-produced supporting changes and commit template/config settings. On commit-prefix failure reuse the explicit recovery diagnostics; never reset history.
- [ ] Run mutator `npm test` and shared lint; commit intended message 4.

## Task 5: real-npm scenarios, docs, and CI

**Files:** Create mutator `test/e2e/parents.test.js`; modify `test/e2e/fixtures/catalog.js`, `helpers/runner.js`, `helpers/registry.js` only where scenario support requires it, `COVERAGE.md`, tool READMEs and repository docs, and the planner CI workflow if it runs a planner integration that needs the paths CLI.

**Interfaces:** Existing harness functions `createProject`, `plan`, `runUpgrade`, `assertResolved`, and schema-3 result helpers. The harness builds `bin/` shims to this checkout's tool entries, so E2E runs the branch's code. Add registry request counters to prove discovery stops without relying on timing.

- [ ] Add immediate-parent success/no-grandparent-query, grandparent-only success, level-3 ignored, no-solution, B-safe-pin auto-clears-C, B-safe-pin leaves-C, B-removes-A, shared parents, indirect vulnerable reintroduction, parent scope conflict, no new overrides, and second-commit hook failure scenarios.
- [ ] For B-removes-A, assert commit 1 bumps B and commit 2 bumps A; independently `npm ci` each committed snapshot and inspect resolved relationships. For auto-cleared C, assert exactly one commit and a skipped child outcome in the result. Add release-age/advisory-race rejection before the first commit.
- [ ] Run new fixtures before implementation/helper updates and confirm failures; then update only required helpers. Keep original PR 1, clear-cache and existing CLI cases passing.
- [ ] Planner integration that uses the real paths CLI must use PATH shims to this checkout (as `clear-cache.integration.test.js` does), not the globally linked tools. If the planner CI workflow gains such a test, install the paths CLI dependencies there (a local `npm ci` in `tools/npm-dep-paths` is enough when shims point at the checkout).
- [ ] Run planner `npm test`, real audit/versions/paths public integration, mutator `npm test`, `npm run test:e2e` on pinned npm 12.1.0 and compatibility npm 11.10.0, and shared lint. Set scratch overrides to the designated tmp root, creating directories first. Inspect changed CLI help (expect no new choice/depth flags) and zero lint warnings. Run the Windows-relevant subset locally where possible and keep new tests free of POSIX-only assumptions (the earlier clear-cache removal test failed on Windows for this reason).
- [ ] Document parent constraints, exact two-level stopping, combined action execution, metadata/cache freshness, partial/complete meanings, per-upgrade commits, skipped-action reporting and the schema decision. Record real-runtime cases. Commit intended message 5.

## Task 6: release

- [ ] Recheck the actual PR 2 base versions (main currently: planner 0.8.0, upgrader 0.5.0, paths 0.7.0, audit 0.5.0, versions 0.2.0). Bump each affected tool once: planner 0.9.0 and upgrader 0.6.0, and paths 0.8.0 only if a documented paths extension was added. Synchronize `package-lock.json` top-level and `packages[""]` versions; any other changed tool gets its own single grouped bump.
- [ ] Rerun affected suites after the bump (planner cache keys include sibling versions) and lint; commit intended message 6.

## Execution handoff

Review this plan with the spec before product changes. Task 2 starts with a spike whose outcome may need the user's confirmation. Start PR 2 from current `origin/main`; if main changes before the branch is cut, update the base versions and the Baseline section.
