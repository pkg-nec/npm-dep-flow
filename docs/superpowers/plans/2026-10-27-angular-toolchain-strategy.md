# Angular toolchain strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `upgrade-angular-toolchain` strategy: the planner recommends a same-major bump of the pinned `@angular/cli` + `@angular/build` pair, and `npm-dep-upgrade` executes it as an `nx migrate` flow.

**Architecture:** The planner treats the pair like a parent action at the project root: candidates come from the `@angular/cli` catalog and the existing scratch resolver (extended to edit root declarations) decides which candidate clears the uncovered branches. The upgrade tool runs the toolchain action first, in the real project (not the staging resolver), commits it, then runs the remaining parent and within-range actions through the existing staged pipeline on the updated tree.

**Tech Stack:** Node.js ESM, `node --test`, `semver`, npm's Arborist (planner resolver worker), git.

**Spec:** `docs/superpowers/specs/2026-10-27-angular-toolchain-strategy-design.md`

## Global Constraints

- Planner schema stays `schemaVersion: 3`; the new strategy value is `upgrade-angular-toolchain`, label `Upgrade Angular toolchain`. Planner and upgrade are released together.
- The planner applies **no** release-age filter. The upgrade tool enforces at least 7 days (and the configured `before`), checking only `@angular/cli`'s publication time.
- Toolchain members: `@angular/cli` (required root direct dependency) and `@angular/build` (if present); all present members share one current version; target is the same major as current; lowest candidate that clears wins.
- Execution order in the upgrade tool: toolchain, then parent, then within-range.
- Allowlist after `nx migrate`: only `@angular/cli`, `@angular/build`, `@angular-devkit/core`, `@angular-devkit/schematics`, `@schematics/angular`, `@angular-devkit/architect` may change; every changed one except `@angular-devkit/architect` must equal the target version; `@angular-devkit/architect` is not checked. Any other package or version aborts and reverts.
- The `@angular-devkit/core` override is set to the target only if it already exists.
- Install: `npm install --ignore-scripts`; on failure retry with `-f`; then plain again, which must succeed.
- A generated `migrations.json` aborts and reverts. The working tree must be completely clean (no staged, unstaged or untracked changes) before starting.
- Commit subject uses the existing template with description `migrate Angular toolchain to <version>` (default `deps({module}): {description}`, giving `deps(webapp): migrate Angular toolchain to <version>` with `--module webapp`).
- Analysis tools stay read-only; npm/`npx` subprocesses use `runProcess` (Windows `.cmd` through a shell, direct spawn elsewhere); test both paths.
- Conventional Commit headers; version bumps only in the final commit (`npm-dep-upgrade-plan` 0.9.2 → 0.10.0, `npm-dep-upgrade` 0.7.2 → 0.8.0, `package.json` and `package-lock.json` root metadata); shared lint with zero warnings; no rule-disable comments.
- Work in `worktrees/angular-toolchain-strategy`. Run tests per tool: `npm test` (and `npm run test:e2e` for upgrade). Lint from the repo root: `npm --prefix dev-tooling run lint`.

## Review Focus

- The vulnerable package is `@angular/cli`/`@angular/build` itself, so the only consumer is the project root declaration (`location: ''`); coverage must clear that branch when the member installation moves to a safe version, without counting unrelated copies reachable from the root.
- `@angular/build` absent, member versions differing, `@angular/cli` only a transitive dependency, or the override `@angular-devkit/core` absent: strategy not offered (or override not added); never throws.
- After the toolchain commit, the selected target installation no longer exists at the same location/version: remaining actions are reported `already-satisfied`, resolution `complete`, no stale-evidence crash.
- Any failure (dirty tree, out-of-sync lock, `migrations.json`, allowlist, install failing even with `-f`, fresh audit not clear) leaves `git status --porcelain` empty and HEAD unchanged; a failure after the toolchain commit keeps that commit.
- Manifest formatting: setting the override preserves indentation, CRLF and trailing newline; a manifest with `overrides` entries in nested form is not corrupted.

## Intended commits

1. `feat(upgrade-plan): add Angular toolchain candidate helpers` (Task 1)
2. `feat(upgrade-plan): resolve Angular toolchain bumps in the scratch resolver` (Task 2)
3. `feat(upgrade-plan): plan Angular toolchain upgrades` (Task 3)
4. `feat(upgrade): accept and order the Angular toolchain strategy` (Task 4)
5. `feat(upgrade): add Angular toolchain helpers` (Task 5)
6. `feat(upgrade): migrate the Angular toolchain` (Tasks 6 and 7)
7. `test(upgrade): cover the Angular toolchain end to end` (Task 8)
8. `docs: document the Angular toolchain strategy` (Task 9)
9. `chore: bump upgrade-plan and upgrade versions` (Task 10)

This refines the spec's single feature commit into reviewable steps; the version bump stays last.

---

### Task 1: Planner toolchain helpers

**Files:**
- Create: `tools/npm-dep-upgrade-plan/src/toolchain.js`
- Test: `tools/npm-dep-upgrade-plan/test/toolchain.test.js`

**Interfaces:**
- Produces:
  - `export const TOOLCHAIN_STRATEGY = 'upgrade-angular-toolchain'`
  - `export const TOOLCHAIN_MEMBERS = ['@angular/cli', '@angular/build']`
  - `export function toolchainMembers(manifest, graph): { members: Array<{ name, location, version, requestedType }>, version } | null` — `manifest` is the parsed root package.json, `graph` is `{ nodes: Map|array, edges }` from the lockfile/resolver shape (`location`, `name`, `version`). Returns `null` unless `@angular/cli` is a root direct dependency (`dependencies`/`devDependencies`), `@angular/build` (if a root dependency) is installed, and all present members share one installed version.
  - `export function toolchainCandidateVersions(currentVersion: string, catalogVersions: string[]): string[]` — strict stable, newer than current, same major, ascending, no age filter.
  - `export function inToolchainScope(consumerLocation: string, graph, members): boolean` — true when the consumer is the root (`''`) declaring a member, or is a member, or has a member as direct parent (vulnerable package at most two levels below a member).

- [ ] **Step 1: Write failing tests** in `toolchain.test.js`: (a) `toolchainMembers` returns both members for the webapp-shaped fixture (both `21.2.26`), `null` when versions differ, `null` when `@angular/cli` is only transitive, a single member when `@angular/build` is absent; (b) `toolchainCandidateVersions('21.2.26', ['21.2.25','21.2.27','21.3.0','22.0.0','21.2.28-rc.1'])` equals `['21.2.27','21.3.0']`; (c) `inToolchainScope` true for root→member, member, member's direct child, false for a grandchild's child (depth 3) and for an unrelated installation.
- [ ] **Step 2: Run** `cd tools/npm-dep-upgrade-plan && npm ci --ignore-scripts && node --test test/toolchain.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the three functions plus constants in `src/toolchain.js`; reuse `strictStableVersion` by exporting it from `src/strategies.js` rather than duplicating it.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** — `git add tools/npm-dep-upgrade-plan && git commit -m "feat(upgrade-plan): add Angular toolchain candidate helpers"`

### Task 2: Scratch resolver applies a toolchain choice

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/src/resolver-worker.js` (the per-choice loop in `resolveRequest`; `verifyResolution`)
- Test: `tools/npm-dep-upgrade-plan/test/resolver-toolchain.test.js`, `tools/npm-dep-upgrade-plan/test/resolver-toolchain.integration.test.js`

**Interfaces:**
- Consumes: `TOOLCHAIN_STRATEGY` from Task 1 (worker is standalone; import the constant, it has no other dependencies).
- Produces: `resolveRequest` accepts a choice `{ strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation, currentVersion, targetVersion, affectedConsumers }`. It rewrites root declarations of `@angular/cli` and `@angular/build` (whichever are root dependencies, same field, exact `targetVersion` — exact pins stay exact) and the `@angular-devkit/core` override if present, then runs Arborist `buildIdealTree` and saves. It must be accepted first in `request.choices` and may be combined with parent and within-range choices. `verifyResolution` treats the closures of the members before and after as in scope, rejects any other changed installation, and the member installations must land on `targetVersion`. The snapshot and coverage shapes are unchanged.

- [ ] **Step 1: Write failing unit tests** for `verifyResolution` with a toolchain choice (exported already): accepts changes inside the member closures; throws `'Unrelated installation changed'` for a change outside them; throws when a member lands on another version.
- [ ] **Step 2: Write a failing integration test** modelled on `test/resolver-parent.integration.test.js`: local fixture registry with `@angular/cli`/`@angular/build` pinned `1.0.0`, a child `kid` at depth 2 vulnerable at `1.0.0`, and `1.0.1` of both members depending on `kid@1.0.1`. Assert the snapshot's package.json has both members at `1.0.1`, the override set only when it existed, `coverage.resolution === 'complete'`, and a second case where the vulnerable package is `@angular/cli@1.0.0` itself (root consumer `''`): `clearedConsumers` contains the root declaration and `remainingConsumers` is empty (Review Focus 1).
- [ ] **Step 3: Run** `node --test test/resolver-toolchain.test.js test/resolver-toolchain.integration.test.js`. Expected: FAIL.
- [ ] **Step 4: Implement** the toolchain branch in the choice loop: edit the manifest bytes preserving indent/newline (copy the direct-declaration code path), build, save, `verifyResolution`, push snapshot. For a root consumer (`location: ''`) of a member that is the vulnerable package, make `computeCoverage` evaluate reachability from the member's new installation instead of from `''`, so unrelated copies reachable from the root are not counted.
- [ ] **Step 5: Run** the two files and then `npm test`. Expected: PASS, existing parent and within-range resolver tests unchanged.
- [ ] **Step 6: Commit** — `git commit -m "feat(upgrade-plan): resolve Angular toolchain bumps in the scratch resolver"`

### Task 3: Plan toolchain choices

**Files:**
- Create: `tools/npm-dep-upgrade-plan/src/toolchain-planning.js`
- Modify: `tools/npm-dep-upgrade-plan/src/cli.js` (after the `planParentChoices` loop), `tools/npm-dep-upgrade-plan/src/report.js` (`strategyLabels`, `renderStrategies`)
- Test: `tools/npm-dep-upgrade-plan/test/toolchain-planning.test.js`, plus additions to `test/cli.test.js`, `test/report.test.js`, `test/schema3.test.js`

**Interfaces:**
- Consumes: Task 1 helpers; `consumerKey`, `selectResidualChoices` from `coverage.js`; adapters shaped like `planParentChoices`'s (`readCatalog`, `readUpstream`, `resolveChoices`, `readReleasePolicy` not needed).
- Produces: `export async function planToolchainChoices({ finding, row, project, options, controls, adapters }): Promise<{ freshAt: number }>` — same contract as `planParentChoices`. It runs only when `finding.resolution !== 'complete'` and `toolchainMembers(manifest, graph)` is non-null. Uncovered consumers in scope (`inToolchainScope`) are tried against `toolchainCandidateVersions` ascending; the first candidate for which `adapters.resolveChoices(project, item, [toolchainChoice, ...finding.choices])` keeps every existing choice and clears at least one in-scope uncovered consumer wins. On success `finding.choices` becomes `[toolchain, ...parents, ...within-range]` and `finding.resolution` comes from the resolved coverage; otherwise the finding is untouched. The choice is `{ strategy: TOOLCHAIN_STRATEGY, targetPackage: '@angular/cli', targetLocation, currentVersion, targetVersion, affectedConsumers }` with `affectedConsumers` the consumers it clears. Catalog freshness is folded into `freshAt`.

- [ ] **Step 1: Write failing tests** in `toolchain-planning.test.js` (stub adapters as in `parent-planning.test.js`): picks the lowest clearing candidate (resolver stub clears at `21.2.28` not `21.2.27`) and records no age filter (a candidate released yesterday is chosen); keeps an existing within-range choice and orders toolchain first; leaves the finding untouched when no candidate clears; skips when `toolchainMembers` is `null`; skips when resolution is already `complete`; returns `freshAt` of the `@angular/cli` catalog.
- [ ] **Step 2: Add failing tests** to `report.test.js`: Markdown Strategy cell shows `Upgrade Angular toolchain: @angular/cli@21.2.26 → @angular/cli@21.2.27` (other strategies' labels first, then parents, then the toolchain transition, joined by `; `); JSON passes the choice through unchanged. Add a `schema3.test.js` case that a toolchain choice with a root consumer serializes with `schemaVersion: 3`. Add a `cli.test.js` case that the toolchain step runs after the parent step and its `freshAt` bounds the cache expiry.
- [ ] **Step 3: Run** the four files. Expected: FAIL.
- [ ] **Step 4: Implement** `toolchain-planning.js`, wire it into `cli.js` after the parent loop (before the `none` cleanup), and extend `report.js`. Parent resolution inside `planParentChoices` is unchanged.
- [ ] **Step 5: Run** `npm test` in the planner and `npm --prefix dev-tooling run lint` from the root. Expected: PASS, zero warnings. Run `node bin/npm-dep-upgrade-plan.js --help` to confirm help is unchanged.
- [ ] **Step 6: Commit** — `git commit -m "feat(upgrade-plan): plan Angular toolchain upgrades"`

### Task 4: Upgrade accepts and orders the new strategy

**Files:**
- Modify: `tools/npm-dep-upgrade/src/model.js`, `tools/npm-dep-upgrade/src/planner.js` (`validatePlanner`, `selectItem`), `tools/npm-dep-upgrade/src/parents.js` (`orderChoices`)
- Test: `tools/npm-dep-upgrade/test/planner.test.js`, `tools/npm-dep-upgrade/test/parents.test.js`

**Interfaces:**
- Produces:
  - `model.js`: `export const TOOLCHAIN_STRATEGY = 'upgrade-angular-toolchain'`.
  - `planner.js`: `validatePlanner` accepts a toolchain choice with `targetPackage === '@angular/cli'`, canonical `targetLocation` (`node_modules/@angular/cli`), valid `currentVersion` and `targetVersion` with `targetVersion > currentVersion` and the same major, non-empty `affectedConsumers` (a consumer `location` of `''` is allowed); `selectItem` no longer rejects it.
  - `export function splitToolchain(item): { toolchain: choice | null, rest: item }` in `planner.js` — at most one toolchain choice per item (more is `INVALID_PLAN`); `rest.choices` keeps the order of the others.

- [ ] **Step 1: Write failing tests:** a valid toolchain choice passes validation; a different major, a downgrade, a second toolchain choice, and a non-canonical location each fail with `INVALID_PLAN`; `splitToolchain` returns the choice and the remainder; `selectItem` accepts the row.
- [ ] **Step 2: Run** `cd tools/npm-dep-upgrade && npm ci --ignore-scripts && node --test test/planner.test.js test/parents.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the validation branch, `splitToolchain`, and the constant. `orderChoices` stays parent-then-within-range because the toolchain choice is split out before it runs.
- [ ] **Step 4: Run** the files, then `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(upgrade): accept and order the Angular toolchain strategy"`

### Task 5: Upgrade toolchain helpers

**Files:**
- Create: `tools/npm-dep-upgrade/src/toolchain.js`
- Test: `tools/npm-dep-upgrade/test/toolchain.test.js`

**Interfaces:**
- Consumes: `normalizeTimestamp`, `stableVersion` from `registry.js`; `DAY_MS`, `TOOLCHAIN_STRATEGY` from `model.js`; `fail` from `errors.js`.
- Produces:
  - `export const ALLOWLIST = ['@angular/cli', '@angular/build', '@angular-devkit/core', '@angular-devkit/schematics', '@schematics/angular', '@angular-devkit/architect']`
  - `export function selectToolchainRelease(choice, catalog: { versions, releaseTimes: Map, minAgeDays, cutoffMs }, advisories: Array<{ range }>, nowMs: number): { version, releasedAt }` — uses the planned version if it is in the catalog, stable, same major as `choice.currentVersion`, published no later than `min(now - minAgeDays, cutoffMs)` by `@angular/cli`'s time, and not inside an advisory range; otherwise the lowest newer same-major version meeting those conditions; nothing lower than planned; else `fail('RELEASE_AGE' | 'NO_CANDIDATE', 'selection', …)`.
  - `export function checkManifestChanges(beforeManifest, afterManifest, version): void` — compares every dependency field and `overrides`; any change to a package outside `ALLOWLIST` or to an allowlisted package (except `@angular-devkit/architect`) not ending at `version` throws `fail('UNEXPECTED_MANIFEST_CHANGE', 'verification', …)`. A removed allowlisted entry is also a failure.
  - `export function setDevkitOverride(manifestText: string, version: string): string | null` — returns the manifest with `overrides['@angular-devkit/core']` set to `version`, preserving indentation, line endings and trailing newline; `null` if the override does not exist. If the entry is an object, set its `.` key when present, otherwise `fail('UNSUPPORTED_OVERRIDE', 'verification', …)`.

- [ ] **Step 1: Write failing tests:** release selection — planned version used; planned too young but a newer older-than-7-days version does not exist → `RELEASE_AGE`; planned version now vulnerable → lowest newer clean same-major version; major change never chosen; `before` cutoff respected. Manifest checks — cli+build moved to target passes; architect at any version passes; `@angular/core` changed fails; `@angular/build` at a different version fails; `@schematics/angular` at a different version fails. Override — present gets the version with CRLF and a missing trailing newline preserved; absent returns `null`.
- [ ] **Step 2: Run** `node --test test/toolchain.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions. `selectToolchainRelease` follows `selectParentRelease` in `parents.js` and checks only `@angular/cli`'s publication time.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(upgrade): add Angular toolchain helpers"`

### Task 6: Toolchain migration executor

**Files:**
- Create: `tools/npm-dep-upgrade/src/toolchain-migration.js`
- Modify: `tools/npm-dep-upgrade/src/git.js` (add `assertCleanWorkingTree`)
- Test: `tools/npm-dep-upgrade/test/toolchain-migration.test.js`, `tools/npm-dep-upgrade/test/git.test.js`

**Interfaces:**
- Consumes: Task 5 helpers; `runProcess` (`process.js`); `readDependencyFiles`, `commitUpgrade` (`git.js`); `recordOwnedFiles` (`recovery.js`).
- Produces:
  - `git.js`: `export async function assertCleanWorkingTree(guard): Promise<void>` — fails `GIT_PRECONDITION` unless `git status --porcelain --untracked-files=all` is empty.
  - `export async function migrateToolchain({ guard, project, choice, context, options, adapters }): Promise<{ commit, action }>` where `adapters` are injectable: `run` (default `runProcess`), `readCatalog`, `readCandidateAdvisories`, `selectToolchainRelease`, `verifyFreshAudit`, `commitUpgrade`. `action` is `{ ...choice, targetVersion, outcome: 'applied', targetLocations: [choice.targetLocation], releasedAt, supportingChanges: [] }`.
  - Steps in order, each failing with a distinct `UpgradeError`: `assertCleanWorkingTree`; select release; `npm ci --ignore-scripts` then lock/manifest in sync (`git status` clean and the two files unchanged); `npx nx migrate @angular/cli@<v>`; if `migrations.json` exists → `fail('MIGRATIONS_GENERATED', …)`; status shows only `package.json` modified; `checkManifestChanges`; `setDevkitOverride`; install (`npm install --ignore-scripts`, retry with `-f` on failure, then plain again must pass; install args follow `context.installArgs`); status shows only `package.json` and `package-lock.json` modified; fresh audit shows the finding's affected consumers cleared and no new advisory (reuse `verifyFinalSecurity` from `verify.js` with `changedVersions` from the lockfile diff); `recordOwnedFiles`; commit with description `migrate Angular toolchain to <v>` and `strategy: TOOLCHAIN_STRATEGY`.
  - On any error before the commit: `revertWorkingTree(guard)` (internal) restores every path `git status --porcelain` lists (tracked files via `git checkout HEAD -- <path>`, untracked by deleting only those paths), first asserting HEAD and branch are unchanged; the original error is rethrown with a `Working tree restored.` suffix; `node_modules` is not touched.

- [ ] **Step 1: Write failing tests** with a fake `run` and a real temp git repo (use `test/helpers/git-project.js`): happy path commits exactly `package.json` and `package-lock.json` with subject `deps(webapp): migrate Angular toolchain to 21.2.27`; dirty tree (staged, unstaged and untracked cases) fails before running anything; out-of-sync lock after `npm ci` fails; `migrations.json` produced → `MIGRATIONS_GENERATED` and `git status --porcelain` empty afterwards; off-allowlist edit and wrong-version edit → `UNEXPECTED_MANIFEST_CHANGE` and reverted; plain install fails then `-f` succeeds then plain passes (assert the three calls' args in order); install failing with `-f` too → reverted; plain install failing the second time → reverted; override absent leaves `overrides` untouched; release too young → no subprocess run; Windows path: `runProcess` called with `platform: 'win32'` produces `npx.cmd`/`npm.cmd` through a shell (assert via a spawn spy as in `process.test.js`).
- [ ] **Step 2: Run** `node --test test/toolchain-migration.test.js test/git.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `assertCleanWorkingTree` and `migrateToolchain` as specified; keep the revert and status-check helpers private to the module.
- [ ] **Step 4: Run** both files. Expected: PASS.

### Task 7: Wire the toolchain phase into the CLI

**Files:**
- Modify: `tools/npm-dep-upgrade/src/cli.js`, `tools/npm-dep-upgrade/src/report.js` (only if the toolchain action needs a different row), `tools/npm-dep-upgrade/src/commit-sequence.js` (only if the guard handoff needs it)
- Test: `tools/npm-dep-upgrade/test/cli.test.js`, `tools/npm-dep-upgrade/test/report.test.js`

**Interfaces:**
- Consumes: `splitToolchain` (Task 4), `migrateToolchain` (Task 6), `defaults` object gets `migrateToolchain`.
- Produces: in `mainWithDebug`, after `selectItem` and `loadNpmContext` and before `readEvidence`: when `splitToolchain(item).toolchain` exists, run `migrateToolchain`, then refresh the guard (`head` = commit hash, `originalFiles` and `ownedFiles` = the committed bytes), reload the project, and continue the existing pipeline with `rest` (the item without the toolchain choice). If `rest.choices` is empty, or the target installation no longer exists at its location and version, skip the staged pipeline and report remaining actions as `already-satisfied` with resolution `complete`. The JSON result lists the toolchain action first, then the others, and `commits` includes the toolchain commit with its `actionIndex`. A failure after the toolchain commit keeps that commit and reports it in the error text, like later-commit failures today. The `mutated`/recovery logic must not restore dependency files over the toolchain commit.

- [ ] **Step 1: Write failing CLI tests** with stubbed deps: toolchain-only item → one commit, toolchain action first, no staging created; toolchain + within-range item → `migrateToolchain` called before `readEvidence`, `executeActions` receives only the remaining choices, two commits in order; target gone after the toolchain → remaining actions `already-satisfied`, resolution `complete`; toolchain failure → exit 1 with `npm-dep-upgrade: <stage>: …` on stderr, nothing on stdout; failure in the later phase after a committed toolchain → exit 1, message mentions the completed commit, dependency files not restored over it. Report test: Markdown and JSON include the toolchain action row as `@angular/cli: 21.2.26 → 21.2.27 (applied)`.
- [ ] **Step 2: Run** `node --test test/cli.test.js test/report.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the phase in `cli.js` as described; update the `--help` text only if wording changes (then run `node bin/npm-dep-upgrade.js --help` and check column alignment).
- [ ] **Step 4: Run** `npm test` in `tools/npm-dep-upgrade` and `npm --prefix dev-tooling run lint` from the root. Expected: PASS, zero warnings.
- [ ] **Step 5: Commit** (covers Tasks 6 and 7) — `git commit -m "feat(upgrade): migrate the Angular toolchain"`

### Task 8: End-to-end coverage

**Files:**
- Create: `tools/npm-dep-upgrade/test/e2e/toolchain.test.js`, `tools/npm-dep-upgrade/test/e2e/fixtures/toolchain.js`
- Modify: `tools/npm-dep-upgrade/test/e2e/COVERAGE.md`, `tools/npm-dep-upgrade/test/e2e/helpers/registry.js` only if it cannot serve a fake `nx` package

**Interfaces:**
- Consumes: `createProject`, `plan`, `runUpgrade` (`helpers/`), scenario shape from `fixtures/parents.js`.
- Produces: a scenario with exact-pinned `@angular/cli`, `@angular/build` (with a vulnerable depth-2 child fixed in the next patch) and `@angular-devkit/core` override, plus a fake `nx` package in the local registry whose `migrate @angular/cli@<v>` bin rewrites the allowed manifest entries (and writes `migrations.json` in a second scenario).

- [ ] **Step 1: Write failing tests** for each runtime in `runtimes` (see `parents.test.js` loop): plan reports `resolution: 'complete'` and a toolchain choice; upgrade exits 0 with one commit `deps: migrate Angular toolchain to <v>` and (with `--module webapp`) the `deps(webapp): …` subject; both members and the override at `<v>`; `migrations.json` scenario exits 1, `git status --porcelain` empty, HEAD unchanged; target version younger than 7 days exits 1 with no change; a toolchain + within-range finding yields two commits in the order toolchain, then within-range.
- [ ] **Step 2: Run** `NPM_DEP_UPGRADE_E2E_NPM_CLI=<npm 12.1.0 cli> npm run test:e2e -- --test-name-pattern toolchain` (provision runtimes as `test/e2e/COVERAGE.md` describes). Expected: FAIL.
- [ ] **Step 3: Implement** the fixtures and registry support; fix any product defects the tests expose in the owning module.
- [ ] **Step 4: Run** `npm test` and `npm run test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(upgrade): cover the Angular toolchain end to end"`

### Task 9: Documentation

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/README.md`, `tools/npm-dep-upgrade/README.md`, `README.md` (strategy list if present), `AGENTS.md` (the planner and upgrade sections: one line each for the new strategy and ordering)

- [ ] **Step 1: Update the planner README:** the strategy list and a "Angular toolchain" section (applicability, lowest-clearing, no age filter in the planner, report cell text, JSON choice example with `targetPackage: "@angular/cli"`).
- [ ] **Step 2: Update the upgrade README:** the toolchain flow (the eight steps), the allowlist (architect unchecked), the clean-tree requirement, install fallback, revert behavior, execution order, and `--module webapp` for the commit subject.
- [ ] **Step 3: Verify:** read both README sections against the spec; run `git diff --check`.
- [ ] **Step 4: Commit** — `git commit -m "docs: document the Angular toolchain strategy"`

### Task 10: Version bump

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/package.json`, `tools/npm-dep-upgrade-plan/package-lock.json`, `tools/npm-dep-upgrade/package.json`, `tools/npm-dep-upgrade/package-lock.json`

- [ ] **Step 1: Set** planner `0.9.2 → 0.10.0` and upgrade `0.7.2 → 0.8.0` in each `package.json` and the root `version` plus `packages[""].version` in each `package-lock.json`.
- [ ] **Step 2: Verify:** `npm test` in both tools, `npm run test:e2e` in upgrade, `npm --prefix dev-tooling run lint` from the root, and `node bin/<tool>.js --version` prints the new version for both.
- [ ] **Step 3: Commit** — `git commit -m "chore: bump upgrade-plan and upgrade versions"`
