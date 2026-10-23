# Partial Remediation PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the existing strategy label, then support partial within-range upgrades with planner schema version 3 and verified per-upgrade commits.

**Architecture:** Identify remediation obligations by incoming consumer edges, not by immutable target paths. Select compatible actions and verify their combined resolution in private staging. Execute the actions transactionally, recording npm-produced snapshots and committing each actual upgrade separately after complete verification.

**Tech Stack:** Existing Node.js ESM CLIs, node:test, semver, selected npm's Arborist/config libraries for read-only resolution, existing mutator dependencies, Git, and local-registry E2E fixtures.

**Spec:** [Approved design](../specs/2026-10-23-partial-and-parent-upgrades-design.md).

## Global Constraints

- One finding represents one vulnerable physical installation, independent of its remediation strategies.
- Keep the existing full SHA-256 ID of `package + "__" + targetLocation`.
- Replace `status` with `resolution`; values are exactly `none`, `partial`, `complete`.
- Planner schema version is 3; no version 2 compatibility or migration logic.
- Do not install dependencies, run scripts, or change target files during analysis.
- Keep all tools independent; exchange public JSON and never import sibling private modules.
- Preserve the planner's Node.js >=20 contract and the mutator's existing engine range. Develop on Node 24.21.0; real-npm reference is 12.1.0, compatibility runtime is 11.10.0.
- Task scratch root: `/home/maw/src/nrc/npm-dep-flow-impl/tmp`. Worktree root: `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`.
- Preserve fresh security checks, at least seven days of release age, scripts-disabled installs, effective npm configuration, cache freshness, and Git/concurrency guards.
- No new CLI flags. One item ID executes its whole action set; one commit per actual upgrade.
- Preserve completed-report exit 0, error exit 1, stderr diagnostics, and no partial stdout report on errors.

## Review Focus

1. Shared installations with incompatible ranges: compatible consumers become safe and exact pins remain satisfied (Tasks 2, 4, 6).
2. npm relocation and clean reinstall: verify consumer relationships and reproduce every committed state with npm ci (Tasks 3, 4, 6).
3. Scoped registry credentials, relative config paths, and Node 20: resolve using the selected npm context without leaking credentials or raising the planner engine floor (Task 3).
4. Hooks/concurrent edits after an earlier commit: preserve existing history and external work; report the committed prefix accurately (Task 5).
5. New advisories or supporting changes during execution: reject stale or unsafe results before the first commit (Tasks 4, 6).

## Files and responsibilities

Planner existing files: `src/report.js` renders the public format; `src/strategies.js` filters safe versions; `src/evaluate.js` coordinates findings; `src/cli.js` orchestrates adapters; `src/result-cache.js` and `src/context.js` own cache identity/freshness.

New planner modules: `src/coverage.js` selects consumer subsets; `src/resolver.js` manages private resolution; `src/resolver-worker.js` loads the selected npm's resolver; `src/npm-runtime.js` identifies npm and effective configuration. Keep subprocesses through `src/process.js`.

Mutator existing files: `src/planner.js`, `src/evidence.js`, `src/candidates.js`, `src/scopes.js`, `src/mutation.js`, `src/verify.js`, `src/cli.js`, `src/git.js`, `src/recovery.js`, `src/report.js`.
New mutator modules: `src/coverage.js` verifies/rebinds original consumer obligations; `src/transaction.js` executes and records snapshots; `src/commit-sequence.js` publishes verified snapshots and commits.

Tests live in each tool's `test/`, with new local-registry scenarios in mutator `test/e2e/partial.test.js` and fixtures in `test/e2e/fixtures/catalog.js`. No production cross-tool imports; existing E2E helpers may exercise all public CLIs.

## Shared interface vocabulary

`Consumer = {location, requestedName, type}` uses original consumer identities. `Choice = {strategy, targetPackage, targetLocation, currentVersion, targetVersion, affectedConsumers: Consumer[]}`. Public fields are strings except the consumer array.

`Finding` retains existing identifying/severity/minimum-safe-version fields, removes `status` and singular `strategy`, and adds `resolution` and `choices: Choice[]`.

Internal `Graph` uses the mutator's existing `{nodes: Map<location, Node>, edges: Edge[]}` shape. Worker JSON serializes nodes as an array and reconstructs the map in its adapter. Edges retain raw/effective specs and optional/valid flags. `Coverage = {resolution, clearedConsumers: Consumer[], remainingConsumers: Consumer[]}`.

`Snapshot = {choiceIndex, files: {'package.json': Buffer, 'package-lock.json': Buffer}, graph, supportingChanges, changedVersions}`. `changedVersions` retains the existing Map-based verification shape. An action index is an internal array position, not a public choice ID.

## Intended commit order

1. `fix(upgrade-plan): simplify within-range strategy label` — presentation only, schema 2 unchanged at this point.
2. `feat(upgrade-plan): select compatible consumer actions` — coverage selection and tests.
3. `feat(upgrade-plan): verify consumer splits with read-only resolution` — private resolver/configuration boundary and tests.
4. `feat(upgrade-plan)!: report remediation coverage in schema 3` — public schema, coordinator/cache integration, and planner docs.
5. `feat(upgrade)!: execute schema 3 consumer actions` — schema validation, scope/graph verification, transaction snapshots, executor report version 3.
6. `feat(upgrade): commit each verified upgrade separately` — snapshot replay, commit sequencing/recovery, and tests.
7. `test: verify partial remediation with real npm` — full CLI/E2E matrix and final shared documentation.
8. `chore: release partial remediation support` — grouped minor version bumps only: planner 0.6.0 → 0.7.0 and mutator 0.3.1 → 0.4.0, if these remain the actual PR-base versions.

## Task 1: first change is the Markdown label

**Files:** Modify planner `src/report.js`, `test/report.test.js`, affected rendered-output assertions in `test/cli.test.js`, and `README.md`.

**Interfaces:** Keep `renderMarkdown(rows)` and `renderJson(rows, auditedAt)` signatures and schema 2 unchanged. Only `renderStrategy(strategy)` changes its within-range presentation.

- [ ] Write a failing assertion that the Strategy cell is exactly `Update within declared range`; assert JSON still includes both versions and target package.

```js
assert.match(markdown, /\| Update within declared range \|/)
assert.doesNotMatch(markdown, /Update within declared range:/)
assert.equal(report.rows[0].strategy.targetVersion, '5.0.12')
```

- [ ] Run `node --test test/report.test.js test/cli.test.js` from the planner directory and confirm failure is the old label, not setup.
- [ ] Render only the strategy label for the existing strategy; retain escaping, empty-report behavior, severity, row counts, and other columns. Update the README's example.
- [ ] Run the focused tests and shared lint; commit with intended message 1. Do not bump versions yet.

## Task 2: deterministic compatible-consumer action selection

**Files:** Create planner `src/coverage.js`, `test/coverage.test.js`; modify `src/strategies.js`, `test/strategies.test.js`.

**Interfaces:** Export `consumerKey(consumer): string`, `selectWithinRangeChoices(row, targetLocation, catalog): Choice[]`. Inputs use validated audit requirements and stable-version catalogs already consumed by the planner. Retain `findMinimumSafeVersion` semantics.

- [ ] Write `selects C without forcing pinned B`: A@1.2.3, B requirement `1.2.3`, C requirement `^1.2.0`, safe catalog `[1.2.5]`; assert one choice for C with `targetVersion === '1.2.5'`, and B absent from its consumers.

```js
assert.equal(choices.length, 1)
assert.equal(choices[0].targetVersion, '1.2.5')
assert.deepEqual(choices[0].affectedConsumers, [
  { location: 'node_modules/C', requestedName: 'A', type: 'dependencies' },
])
```

- [ ] Add assertions for all-compatible, none-compatible, two candidate subsets, aliases, root declarations, repeated package versions at distinct locations, invalid specs, and several advisory ranges. Assert `consumerKey` distinguishes declaration type and requested alias.
- [ ] Run `node --test test/coverage.test.js test/strategies.test.js`; confirm the new interface fails before implementation.
- [ ] Select stable safe versions by maximum remaining compatible coverage, then lowest version and deterministic string tie-break. Remove covered consumers and repeat. Do not claim final resolution until Task 3 verifies feasibility.
- [ ] Run the focused tests; commit with intended message 2.

## Task 3: read-only npm resolution and coverage verification

**Files:** Create planner `src/npm-runtime.js`, `src/resolver.js`, `src/resolver-worker.js`, `test/npm-runtime.test.js`, `test/resolver.test.js`, `test/resolver.integration.test.js`; modify `src/context.js` and its tests.

**Interfaces:** `readResolverRuntime(projectRoot, adapters): Promise<{npmPath, npmVersion, resolverVersion}>`; `resolveChoices(project, row, choices, options): Promise<{choices, coverage: Coverage, graph: Graph, freshAt: number}>`. Options carry TTL/bypass/debug and injected subprocess/runtime adapters. Worker JSON accepts original project path, private project path, finding, and choices; returns graph arrays and relevant metadata freshness, never configuration secrets.

- [ ] Write failing tests that exact pins stay valid, compatible consumers move safely, and an unexpressible split removes the action instead of forcing a pin. Assert target input hashes and directory contents are unchanged, no node_modules is created, and no lifecycle script runs.

```js
assert.equal(result.coverage.resolution, 'partial')
assert.equal(result.coverage.remainingConsumers[0].location, 'node_modules/B')
assert.deepEqual(afterTargetFiles, beforeTargetFiles)
assert.equal(reifyCalls, 0)
```

- [ ] Test scoped credentials, relative certificate/cache paths, a Windows npm.cmd launcher, Unix symlinks, npm version/path mismatch, malformed worker output, required peers, and resolver cleanup on failure.
- [ ] Run `node --test test/npm-runtime.test.js test/resolver.test.js`; confirm missing interfaces fail.
- [ ] Locate selected npm independently using local launcher/package metadata, checking `npm --version` against that package. Load its own Arborist/config libraries with `createRequire` in the worker; do not add mutator Arborist 10 as a planner dependency. Preserve planner Node >=20 and test with a Node-20-compatible selected npm. Fail clearly if its resolver cannot be loaded.
- [ ] Load effective configuration at the original project root before switching resolution to private inputs. Preserve resolved path settings and auth in memory. Use Arborist virtual/ideal-tree construction and npm-owned lockfile serialization in private staging; never call reify, npm install, or lifecycle runners during planning. Use reversible scoped rules for within-range targeting, then prove the split survives cleanup under the original declarations and existing override policy.
- [ ] Compare original and resolved consumer edges. Return `none` for valid graphs with no retained feasible action; resolver/network/malformed-data failures remain errors. Deduplicate covered consumers and validate the selected action set jointly. Record the oldest source freshness and debug external requests without credentials.
- [ ] Run focused tests plus local-registry integration on npm 12.1.0 and 11.10.0; assert expected graph relationships after cleanup. Verify planner startup and resolver worker on Node 20 with compatible npm before committing intended message 3.

## Task 4: planner schema 3 and cache integration

**Files:** Modify planner `src/evaluate.js`, `src/cli.js`, `src/report.js`, `src/result-cache.js`, `src/context.js`, `test/report.test.js`, `test/cli.test.js`, `test/result-cache.test.js`, `test/context.test.js`, `test/audit.integration.test.js`, and `README.md`.

**Interfaces:** `evaluateFindings(rows, versionsByPackage, {resolveChoices, project, options}): Promise<Finding[]>`. CLI awaits it and includes resolver evidence in freshness. Renderers retain their argument lists and emit schema 3 choices/resolution.

- [ ] Write failing report tests asserting `schemaVersion === 3`, no `status` or singular `strategy`, no choice IDs/search fields, `none` with empty choices, stable finding IDs, and exact Markdown `Resolution` heading. Test partial/complete/none and an empty audit.

```js
assert.equal(report.schemaVersion, 3)
assert.equal(report.rows[0].resolution, 'partial')
assert.equal(Object.hasOwn(report.rows[0], 'status'), false)
assert.equal(Object.hasOwn(report.rows[0], 'strategy'), false)
```

- [ ] Test a cached complete plan expires at its oldest audit/catalog/resolver source; resolver/version/config changes invalidate it; `--no-cache` bypasses every nested cache. Keep `--no-cache` working without requiring unrelated cache-identity discovery.
- [ ] Run `node --test test/report.test.js test/cli.test.js test/result-cache.test.js test/context.test.js` and confirm expected failures.
- [ ] Wire Tasks 2–3 into the planner; render distinct labels in deterministic order, em dash for none, and retain all existing severity/minimum-safe fields. Increment the cache-format discriminator so old findings cannot enter the new renderer. Preserve error/no-partial-stdout behavior and empty-audit fast path.
- [ ] Run planner `npm test`, its public audit integration, and shared lint. Update docs to explain the action set and partial meaning; commit intended message 4 with a breaking-change footer.

## Task 5: executor schema 3, consumer scopes, and transaction snapshots

**Files:** Modify mutator `src/planner.js`, `src/evidence.js`, `src/candidates.js`, `src/scopes.js`, `src/mutation.js`, `src/verify.js`, `src/cli.js`, `src/report.js`; create `src/coverage.js`, `src/transaction.js`, `test/coverage.test.js`, `test/transaction.test.js`; update corresponding existing unit tests.

**Interfaces:** `validatePlanner` and `selectItem` keep signatures, accept schema 3 only and reject `none`. `verifyCoverage(originalEvidence, currentGraph, choices): Coverage` rebinds original consumers. `executeActions(project, item, evidence, context, adapters): Promise<{snapshots: Snapshot[], actions, coverage}>` resolves all actions privately. Action outcomes are `applied` or `already-satisfied`.

- [ ] Write failing validation tests for unknown/legacy schemas, mismatched finding/action packages, missing/duplicate consumer edges, invalid locations/versions, empty partial/complete actions, and none with actions. Selection still uses finding-ID prefix and package filter only.
- [ ] Write transaction tests proving a shared installation may split/relocate, original B pins remain satisfied, unrelated installations/consumers do not change, and peer/alias scope failures safely abort. Test stale target/candidate advisories and vulnerable or too-young supporting changes.

```js
assert.equal(result.coverage.resolution, 'partial')
assert.equal(result.snapshots.length, 1)
assert.equal(result.actions[0].outcome, 'applied')
assert.equal(commitCalls.length, 0)
```

- [ ] Run `node --test test/planner.test.js test/coverage.test.js test/transaction.test.js test/verify.test.js test/scopes.test.js`; confirm failures before implementation.
- [ ] Validate choices against fresh evidence. Select fresh age-compliant candidates preserving their consumer subsets. Restrict scoped overrides to the selected consumers, retain existing cleanup, and verify logical graph obligations rather than immutable child paths. Preserve parents for within-range actions; the parent-change allowance belongs to PR 2.
- [ ] Execute actions deterministically, reassess coverage after each, save synchronized npm-produced snapshots only for actual upgrades, and verify each intermediate state plus the full staged result. Actual installation and fresh final security checks must succeed before commits. Skip already-satisfied actions and reject unexpected regressions.
- [ ] Change executor result JSON to version 3: `{schemaVersion, id, package, oldVersion, targetLocation, resolution, actions, commits}`. Each action contains its original choice fields, `outcome`, actual target version/locations, and supportingChanges; each commit contains `hash`, `subject`, `actionIndex`, and `changedFiles`. Remove ambiguous singular newVersion/commit fields. Markdown lists performed/skipped actions and ordered commits under one tool-name H1.
- [ ] Run mutator `npm test` and shared lint; update executor docs and commit intended message 5 with breaking-change footer. This commit may initially publish the single-action path; Task 6 completes multi-action publication before PR submission.

## Task 6: verified snapshot replay and per-action commits

**Files:** Create mutator `src/commit-sequence.js`, `test/commit-sequence.test.js`; modify `src/git.js`, `src/recovery.js`, `src/cli.js`, `test/git.test.js`, `test/recovery.test.js`.

**Interfaces:** `commitSnapshots(guard, snapshots, actions, context, options, adapters): Promise<Commit[]>`; `Commit = {hash, subject, actionIndex, changedFiles}`. Advance the guard's head/originalFiles/ownedFiles only after validating a tool-owned commit. Recovery distinguishes pre-commit failure from a committed prefix.

- [ ] Write failing tests for two snapshots/two commits, one skipped action/one commit, no empty commits, and unchanged unrelated unstaged files. Assert each commit's dependency bytes equal its verified snapshot and the configured template/args apply separately.

```js
assert.equal(commits.length, 2)
assert.deepEqual(commits.map(commit => commit.actionIndex), [0, 1])
assert.deepEqual(committedDependencyStates, verifiedSnapshotStates)
```

- [ ] Test second-commit hook rejection, hook changes to files/index, another process moving HEAD between commits, and external dependency edits during replay. Assert no reset, no overwritten external bytes, known committed hashes in stderr, and no partial JSON success output.
- [ ] Run `node --test test/commit-sequence.test.js test/git.test.js test/recovery.test.js` and confirm failures.
- [ ] Replay each verified snapshot with guards before every write. Install its matching tree with scripts disabled before running hooks; recheck files and security if replay introduces new evidence. Commit using the existing hook wrapper. Update the expected baseline after each successful commit. On failure before any commit restore owned files; after a committed prefix preserve history and report exact remaining state.
- [ ] Run focused tests, mutator `npm test`, and shared lint; commit intended message 6.

## Task 7: complete real-npm integration, documentation, and release

**Files:** Add `test/e2e/partial.test.js`; modify mutator E2E `fixtures/catalog.js`, `helpers/runner.js`, impacted schema/status assertions, `COVERAGE.md`, both tool READMEs, repository README/AGENTS/CONTRIBUTING contract descriptions, and relevant CI checks if needed. Package metadata changes only in the final release commit.

**Interfaces:** Update `plan`, `runUpgrade`, and `assertSuccess` helpers to understand schema 3, resolution, action results, and ordered commits. Preserve existing single-action scenarios and the independent audit/paths/versions schema 2 contracts.

- [ ] Add exact/caret shared-A fixtures, disjoint safe-range subsets needing two upgrades, clean reinstall reproduction of every snapshot, preserved original pins, multi-location finding IDs, and stale-advisory rejection before any commit. Existing T06 shared-pin failure expectations must become partial-success expectations where expressible.
- [ ] Run new cases before fixing helper assertions; confirm failures identify the new contract/behavior. Update helpers and coverage matrix, retaining explicit tests for unsupported scope rather than silently accepting any error.
- [ ] Install each tool's dependencies with `npm ci --ignore-scripts`; install shared lint dependencies separately. Set TMPDIR, NPM_DEP_FLOW_TEST_TMPDIR, and NPM_DEP_PATHS_TEST_TMPDIR to the designated scratch root. Provision or reuse pinned runtime entries outside isolated cases.
- [ ] Run planner `npm test`, `NPM_DEP_AUDIT_INTEGRATION=1 npm test` with checkout sibling CLIs on PATH, mutator `npm test`, and `npm run test:e2e` with both runtime entry variables. Run `npm --prefix dev-tooling run lint` from repository root and inspect both changed CLI `--help` outputs. Expected: all required suites pass, both npm runtimes execute their matrix, zero lint warnings.
- [ ] Commit tests/docs with intended message 7. Bump each affected tool once relative to the PR base, synchronizing package.json and package-lock root versions; verify metadata and rerun affected tests. Commit intended message 8. No parent strategy ships in this PR.

## Execution handoff

Review this plan before implementation and choose native or subagent-driven execution. Execute PR 1 independently; PR 2 has its own dependent plan. Do not implement product code before that review.


## Native execution record

PR 1 implemented Tasks 1–7. Parent discovery and parent upgrade execution remain deferred to PR 2. Native execution used one independent final review and one correction pass; no second review was requested. The review found three important issues, all reproduced before correction: installed verification missed tarball-only dependency edges, post-commit verification failures omitted a created commit, and supporting changes omitted removals. Corrections read installed manifests without the hidden-lock shortcut, compare installed relationships with the verified graph, preserve independently verified commit evidence, and report removed supporting installations. No minor findings were deferred.

Implementation rulings and their costs:

- Keep scratch, test logs, and the execution ledger in the user-designated temporary directory; this requires manual bookkeeping instead of the skill's default scratch layout.
- Run subprocess-heavy tests outside sandbox restrictions after EPERM/empty-output failures; this changes test execution permissions without a product workaround.
- Read the planner's own virtual graph during scoped resolution instead of repeatedly invoking paths; this maintains another graph adapter while preserving the public sibling CLI boundary.
- Keep pure synchronous strategy evaluation and coordinate asynchronous split verification in the CLI; this adds a coordinator step while retaining cheap evaluator tests.
- Keep ordinary single-action, whole-installation planning metadata-only, and verify new consumer splits and multiple-action sets with npm; execution always performs fresh installed verification.
- Keep independent resolver workers inside the two tools to avoid sibling private imports; duplicated resolution logic must be maintained and tested on both runtimes.
- Commit Tasks 5 and 6 together because the executor result and snapshot publication must work together; the executor commit is correspondingly larger.
- Prefer real-npm transaction scenarios over a second heavily mocked transaction harness; feedback is slower but exercises actual split behavior and reproducible lockfiles.
- Restore owned dependency files after a first commit failure when guards permit; retain a committed prefix after subsequent failures. Recovery may require rebuilding node_modules and never resets history or overwrites concurrent edits.

Release versions remain planner 0.7.0 and mutator 0.4.0. Schema 3 is required; no version 2 migration is included. Parent strategy work remains intentionally outside this review.

Final verification: planner/public audit integration 100 passed with one optional skip; mutator units 89 passed; real-npm E2E matrix 134 passed on npm 12.1.0 and npm 11.10.0; shared lint passed with zero warnings. Node 20.20.2 with compatible npm 11 passed the read-only split resolver check. Release metadata is synchronized and both changed CLI help outputs were inspected.
