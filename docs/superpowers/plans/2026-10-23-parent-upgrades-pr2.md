# Parent Dependency Upgrades PR 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-level parent upgrades to PR 1's remediation action set, executing parents first and committing each actual upgrade separately.

**Architecture:** Discover unresolved consumer branches through public paths graphs, search ancestors breadth-first up to two levels, and stop climbing a branch at its first executable suitable candidate. Extend PR 1's read-only resolver and transaction executor to handle ancestor closures, skipping redundant within-range work after each parent action.

**Tech Stack:** PR 1's Node.js ESM tools, selected npm resolver, node:test, semver, public paths/versions CLI adapters, Git, existing real-npm local-registry harness.

**Spec:** [Approved design](../specs/2026-10-23-partial-and-parent-upgrades-design.md). **Dependency:** [PR 1 plan](2026-10-23-partial-remediation-pr1.md), implemented and verified first.

## Global Constraints

- Maximum ancestor depth is exactly 2: immediate parent, then grandparent.
- Stop climbing each unresolved branch at its first suitable level. Do not expose ancestor search status or add a depth flag.
- Parent upgrades satisfy every incoming declared requirement, introduce no new override entries, and use npm-produced synchronized dependency files.
- One finding ID remains package + installation location; resolutions/strategies do not split findings.
- JSON choices form one compatible action set. No choice IDs, selection flag, competing alternatives, or completeResolutionOptions.
- Execute parent actions before residual within-range actions; skip work already satisfied. Verify the whole transaction before committing and create one commit per actual upgrade.
- Retain planner schema 3 if its contract is sufficient; use schema 4 only for a necessary incompatible change, updating the executor simultaneously. No older-schema migration logic.
- Preserve PR 1's runtime floors, independent CLI boundaries, security/configuration/cache rules, error contracts, and Git ownership/concurrency guards.
- Worktrees: `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`; task scratch: `/home/maw/src/nrc/npm-dep-flow-impl/tmp`.

## Review Focus

1. Immediate-parent success with a newer grandparent available: no grandparent candidate request is made for that resolved branch (Task 1).
2. Shared ancestor reached by several branches: deduplicate one upgrade and satisfy all its incoming ranges, including other consumers (Tasks 1, 2).
3. Parent drops A directly but reintroduces it through another descendant: do not claim that branch is safe (Task 2).
4. npm leaves C on vulnerable A after upgrading B to a safe exact pin: perform residual work instead of assuming deduplication (Task 4).
5. Second commit fails after a successful parent commit: preserve history and give exact remaining-state diagnostics (Tasks 4, 5).

## Files and responsibilities

Planner new modules: `src/ancestors.js` owns bounded traversal/search; `src/paths.js` validates public upstream graph responses; `src/metadata.js` fetches and caches exact-release dependency metadata under effective npm context. New tests match module names.

Planner modified modules from PR 1: `src/evaluate.js` adds parent discovery for uncovered obligations; `src/resolver.js` and `src/resolver-worker.js` verify descendant closures and combined actions; `src/cli.js`, `src/context.js`, `src/result-cache.js`, `src/report.js` wire freshness and rendering. Keep versions catalogs through the public versions CLI; do not extend that tool merely to fetch release manifests.

Mutator: extend `src/transaction.js`, `src/coverage.js`, `src/verify.js`, `src/evidence.js`, `src/planner.js`, `src/cli.js`; create `src/parent-mutation.js` for the no-new-overrides parent operation and its tests. Reuse PR 1 snapshot/commit sequencing.

E2E: add `test/e2e/parents.test.js`, fixtures and checkpoint controls; update coverage/docs and package versions in the final release commit.

## Interfaces inherited and added

Reuse PR 1 `Consumer`, `Choice`, `Finding`, `Coverage`, `Graph`, `Snapshot`, `executeActions`, and `commitSnapshots` definitions. Parent choices use `strategy: 'upgrade-via-parent-dependency'`; target fields describe the ancestor, affectedConsumers identify original finding branches.

`UpstreamGraph = {nodes: Map<location, {location,name,version}>, edges: {from,to,requestedName,type,spec}[]}`.

`readUpstream(projectRoot, row, options): Promise<UpstreamGraph>` consumes and merges existing exact-target `npm-dep-paths --upstream-of <name@version> --format json` responses. Validate locations, completeness, identities, and edge declarations against finding evidence.

`findParentChoices(row, unresolvedConsumers, graph, adapters): Promise<{choices: Choice[], freshAt: number}>` receives adapters `readCatalog(packageName)`, `readManifest(packageName, version)`, and `resolveChoices(choices)`. Metadata results contain original fetchedAt; in-flight lookups share package/version/context keys.

`applyParentChoice(staging, choice, evidence, context, adapters): Promise<{snapshot: Snapshot|null, outcome}>` never introduces an override or forces a declaration. Runtime result may be already-satisfied.

## Intended commit order

1. `feat(upgrade-plan): search two ancestor levels for remediation` — graph adapter, bounded search, metadata reuse and tests.
2. `feat(upgrade-plan): verify parent remediation action sets` — no-override feasibility, descendant security, combined coverage/cache integration.
3. `feat(upgrade-plan): report parent upgrade transitions` — Markdown and public parent choice schema, executor validation. Use `!` and a breaking footer if schema 4 is necessary.
4. `feat(upgrade): execute parent upgrades before residual updates` — parent mutation, obligation reassessment, snapshots and per-action commits.
5. `test: verify mixed parent remediation transactions` — E2E matrix and final docs.
6. `chore: release parent dependency upgrades` — grouped minor bumps relative to PR 2's actual base; if PR 1 shipped planner 0.7.0/mutator 0.4.0, use 0.8.0/0.5.0.

## Task 1: bounded graph discovery and candidate metadata

**Files:** Create planner `src/paths.js`, `src/ancestors.js`, `src/metadata.js`, `test/paths.test.js`, `test/ancestors.test.js`, `test/metadata.test.js`; extend context/debug adapters where needed.

**Interfaces:** Implement `readUpstream` and `findParentChoices` above; export `MAX_ANCESTOR_LEVELS = 2`. `readManifest(projectRoot, packageName, version, options): Promise<{manifest, fetchedAt}>` uses the selected npm context and exact versions, with persistent TTL cache and in-flight memoization. Use the runtime/config boundary introduced by PR 1; never log credentials.

- [ ] Write `stops after immediate-parent success`: B@1.0.1 → B@1.1.0 clears its A branch; assert only B candidate metadata is requested and no grandparent candidate is evaluated.

```js
assert.equal(MAX_ANCESTOR_LEVELS, 2)
assert.equal(result.choices[0].targetPackage, 'B')
assert.deepEqual(requestedCandidatePackages, ['B'])
assert.equal(grandparentCandidateCalls, 0)
```

- [ ] Write grandparent fallback, two-level failure with a safe level-3 ancestor, independent B/D branches, shared-grandparent deduplication, root-stop, cycles, aliases, and required incoming-range validation tests. Assert final choices contain no search fields.
- [ ] Add public-paths validation tests for wrong schema, missing edges, alias identity, malformed nodes, repeated names at different locations, and shared graph merging. Add metadata tests for exact-version keying, scoped config, bypass, TTL, concurrent lookup reuse, and expired-source timestamps.
- [ ] Run `node --test test/paths.test.js test/ancestors.test.js test/metadata.test.js` and confirm missing interfaces fail.
- [ ] Implement a reverse adjacency index and breadth-first levels over unresolved branches. Prefer lowest suitable newer stable candidate and deterministic location ordering. Suitability includes incoming compatibility and executable no-override resolution through the injected resolver. Do not enumerate root-to-target paths, evaluate level 3, or climb branches already covered.
- [ ] Use public versions catalogs and exact-release metadata through the selected npm runtime; persist only safe metadata plus freshness/config digests. Bound metadata request concurrency to 4. Treat malformed/network responses as errors, not no-solution evidence.
- [ ] Run focused tests and shared lint; commit intended message 1.

## Task 2: combined resolution and no-override feasibility

**Files:** Modify planner `src/evaluate.js`, `src/resolver.js`, `src/resolver-worker.js`, `src/cli.js`, `src/context.js`, `src/result-cache.js`; extend `test/resolver.test.js`, `test/resolver.integration.test.js`, `test/cli.test.js`, `test/result-cache.test.js`.

**Interfaces:** Extend PR 1 `resolveChoices` for parent strategy; preserve its return shape. `evaluateFindings` accumulates compatible within-range and parent actions and derives final resolution from the jointly resolved graph.

- [ ] Write failing cases for safe exact child replacement, direct removal, indirect vulnerable reintroduction, unsafe replacement version, conflicting shared ancestors, unrelated target installations, and parent candidates excluded by another incoming requirement.

```js
assert.equal(removalResult.coverage.resolution, 'complete')
assert.equal(reintroducedResult.coverage.resolution, 'none')
assert.deepEqual(afterManifest.overrides, beforeManifest.overrides)
```

- [ ] Assert parent resolution introduces no override entries, modifies no source target files, and keeps manifest/lockfile synchronized through npm serialization. A version that cannot be selected by a normal within-range operation is not suitable, even if its standalone manifest is safe.
- [ ] Test combined-action coverage with relocation, required peers, and a parent resolving an initially planned within-range obligation. Assert catalog/manifest/resolver evidence all constrain expiry; bypass and credential rotation invalidate reuse.
- [ ] Run focused resolver/CLI/cache tests; confirm failures before implementation.
- [ ] Resolve candidate parent updates through npm's named update operation under original declarations; never pin transitive candidates using new overrides or edit lockfile entries. Require actual resulting version and scope to match the tested candidate. If named update also changes unrelated copies and cannot be isolated under normal npm semantics, reject that candidate rather than broaden scope.
- [ ] Validate every original obligation through the changed descendant closure. Reject combined conflicts; try remaining candidates at the same level before considering grandparents. Deduplicate actions targeting the same ancestor only when one compatible result covers their obligations. Retain the feasible subset and report partial/none when valid constraints exclude the rest; reserve fatal errors for resolver/network/malformed-data failures. Do not fabricate completeness by merging independent claims.
- [ ] Run planner `npm test`, local-registry resolver tests with both npm runtimes, and shared lint; commit intended message 2.

## Task 3: parent choice reporting and schema decision

**Files:** Modify planner `src/report.js`, `test/report.test.js`, `test/cli.test.js`, `README.md`; mutator `src/planner.js`, `test/planner.test.js`; repository README as needed.

**Interfaces:** Reuse schema 3 `Choice` and row `resolution/choices` if no required public field is missing. Ancestor level belongs to internal execution evidence and is recomputed from fresh graph data; it need not be a public field.

- [ ] Write failing Markdown assertions for `Update within declared range` and `Upgrade via parent dependency: B@1.0.1 → B@1.1.0` in the same item. Test multiple parent transitions, scoped names, escaping, none/partial/complete, deterministic ordering, and unchanged finding IDs across strategy changes.

```js
assert.match(markdown, /Update within declared range/)
assert.doesNotMatch(markdown, /Update within declared range:/)
assert.match(markdown, /Upgrade via parent dependency: B@1\.0\.1 → B@1\.1\.0/)
assert.equal(report.rows[0].id, originalFindingId)
```

- [ ] Write executor validation tests for ancestor package differing from vulnerable package, a forged parent target outside two levels, a parent choice with incorrect covered consumers, and an unsupported strategy. Validate relationship claims against fresh evidence rather than trusting JSON alone.
- [ ] Run planner report/CLI tests and mutator planner tests; confirm failures before implementation.
- [ ] Render within-range label first and distinct parent transitions after it. Keep original severity and safe-version columns and one row per installation. Add the parent strategy to the action validator without relaxing required fields.
- [ ] Record the schema decision in both READMEs: default is retaining 3 because existing target and consumer fields suffice. If a required incompatible field is discovered during implementation, stop and document schema 4 in this task, update both producer/consumer tests and cache identity together, and implement no migration reader.
- [ ] Run focused suites and shared lint; commit intended message 3, marking breaking only if necessary.

## Task 4: parent-first executor and residual action reassessment

**Files:** Create mutator `src/parent-mutation.js`, `test/parent-mutation.test.js`; modify `src/transaction.js`, `src/coverage.js`, `src/evidence.js`, `src/verify.js`, `src/cli.js`, corresponding unit tests, and `test/commit-sequence.test.js`.

**Interfaces:** Implement `applyParentChoice`; extend `executeActions` to order parents by fresh ancestor level ascending, then original location/name/version, followed by deterministic within-range actions. Preserve PR 1 snapshots/result/commit interfaces.

- [ ] Write B-safe-pin tests for both npm outcomes: C becomes safe and A is skipped, or C stays vulnerable and A executes. Assert one and two snapshots respectively.
- [ ] Write B-removes-A test requiring residual C upgrade and two snapshots; verify remaining branch identities survive relocation. Add all-incoming-range, unchanged override policy, duplicate-parent-action, shared-copy scope rejection, and fresh-security tests.

```js
assert.deepEqual(performedPackages, ['B', 'A'])
assert.equal(result.snapshots.length, 2)
assert.equal(result.coverage.resolution, 'complete')
assert.deepEqual(commitSubjects, [
  'deps: bump B from 1.0.1 to 1.1.0',
  'deps: bump A from 1.2.3 to 1.2.5',
])
```

- [ ] Test complete transaction validation before any commit, one commit per performed upgrade, no commit for skipped actions, parent commit first, and second-commit hook failure preserving the first commit and external edits.
- [ ] Run mutator focused transaction/parent/coverage/verify/commit tests and confirm failures before implementation.
- [ ] Apply the same tested normal npm named-update operation used by planning, without override entries. Scope changes to the parent closure and explicitly covered shared edges; retain unrelated consumers and installations. Verify original ancestor incoming constraints remain satisfied.
- [ ] After each action reload graph/evidence and bind consumers through original relationships; removal of B's A declaration clears that obligation. Do not treat disappearance of an arbitrary location as remediation. Skip a residual child upgrade only when its whole intended effect is already satisfied; keep expected partial/complete coverage stable.
- [ ] Validate final actual tree and fresh security, then invoke PR 1 snapshot commit sequencing. Preserve each action's npm-produced supporting changes and individual commit template/config settings. On commit-prefix failure reuse the explicit recovery diagnostics, never reset history.
- [ ] Run mutator `npm test` and shared lint; commit intended message 4.

## Task 5: real-npm scenarios, docs, and release

**Files:** Create mutator `test/e2e/parents.test.js`; modify `test/e2e/fixtures/catalog.js`, `helpers/runner.js`, `helpers/registry.js` only where scenario support requires it, `COVERAGE.md`, tool READMEs and repository docs. Final grouped package/lock version changes belong only to the release commit.

**Interfaces:** Existing harness functions `createProject`, `plan`, `runUpgrade`, `assertResolved`, and schema-3 result helpers from PR 1. Add registry request counters to prove discovery stops without relying on timing.

- [ ] Add immediate-parent success/no-grandparent-query, grandparent-only success, level-3 ignored, no-solution, B-safe-pin auto-clears-C, B-safe-pin leaves-C, B-removes-A, shared parents, indirect vulnerable reintroduction, parent scope conflict, no new overrides, and second-commit hook failure scenarios.
- [ ] For B-removes-A, assert commit 1 bumps B and commit 2 bumps A; independently npm ci each committed snapshot and inspect resolved relationships. For auto-cleared C, assert exactly one commit and an already-satisfied child outcome. Add release-age/advisory-race rejection before the first commit.
- [ ] Run new fixtures before implementation/helper updates and confirm failures; then update only required helpers. Keep original PR 1 and existing CLI cases passing.
- [ ] Run planner `npm test`, real audit/versions public integration, mutator `npm test`, `npm run test:e2e` on pinned npm 12.1.0 and compatibility npm 11.10.0, and shared lint. Set all scratch overrides to the designated tmp root. Inspect changed CLI help; expect no new choice/depth flags and zero lint warnings.
- [ ] Document parent constraints, exact two-level stopping, combined action execution, metadata/cache freshness, partial/complete meanings, and per-upgrade commits. Record real-runtime cases and schema decision. Commit intended message 5.
- [ ] Bump affected tool minors once relative to the actual PR 2 base, synchronize lock metadata, run affected suites after the bump, and commit intended message 6. Any additional changed tool requires its own single grouped version bump and verification.

## Execution handoff

Review this dependent plan with PR 1's plan and choose an execution method before product changes. Start PR 2 only from the reviewed PR 1 result; update exact base versions if PR 1 changes during review.
