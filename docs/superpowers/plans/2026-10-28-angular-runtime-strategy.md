# Angular runtime strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `upgrade-angular-runtime` strategy by first generalizing the merged Angular toolchain code into a line-driven design, then adding the runtime line as a second registry entry.

**Architecture:** Each tool keeps its own registry of Angular lines (strategy id, label, members, anchor package, overrides, allowlist, commit text). The toolchain modules become line-parameterized with unchanged toolchain behavior (Tasks 1-4, refactor only); the runtime line is then data plus tests (Tasks 5-9). The planner resolves any line's choice first; the upgrade tool runs line choices as an ordered list of pre-phases (toolchain, then runtime) before the staged parent and within-range pipeline.

**Tech Stack:** Node.js ESM, `node --test`, `semver`, npm's Arborist (planner resolver worker), git.

**Spec:** `docs/superpowers/specs/2026-10-28-angular-runtime-strategy-design.md` (builds on `2026-10-27-angular-toolchain-strategy-design.md`)

## Global Constraints

- **Commit order is binding:** Tasks 1-4 are behavior-preserving refactor commits that come before any commit introducing runtime behavior. Every existing planner and upgrade test (unit and e2e, including all toolchain scenarios) passes with unchanged assertions after each refactor task; tests may be renamed or parameterized but not weakened. Toolchain JSON, Markdown, CLI and error text stays byte-identical.
- Planner schema stays 3. New strategy `upgrade-angular-runtime`, label `Upgrade Angular runtime`; runtime members: `@angular/common`, `@angular/compiler`, `@angular/compiler-cli`, `@angular/core`, `@angular/forms`, `@angular/platform-browser`, `@angular/router` (declared in the root `dependencies` or `devDependencies`); anchor `@angular/core` (catalog, release time, `nx migrate` argument, choice `targetLocation` `node_modules/@angular/core`); override `@angular/platform-browser-dynamic` updated to the target only if it exists.
- The planner applies no release-age filter; the upgrade tool enforces 7 days and the configured `before` by `@angular/core`'s publication time. One choice per line per finding; same major only; lowest clearing version wins.
- Planner strategy order: within-range, parent, toolchain, runtime (each covers only branches earlier ones left). Resolver choice order: toolchain, runtime, parent, within-range. Upgrade execution order: toolchain, runtime, parent, within-range.
- Runtime allowlist after `nx migrate`: only the seven runtime members and the `@angular/platform-browser-dynamic` override may change, all must equal the target; no unchecked member (toolchain keeps `@angular-devkit/architect` unchecked). Anything else aborts and reverts.
- Command `npx --no nx migrate @angular/core@<v>`; commit description `bump Angular runtime to <v>` (`deps(webapp): bump Angular runtime to <v>` with `--module webapp`). Flow rules carried over: clean tree incl. untracked files, `npm ci --ignore-scripts` + sync check, `migrations.json` aborts, install plain → `-f` → plain, fresh audit, narrowed revert, `npm_config_ignore_scripts=true` for `nx`, Windows `.cmd` through a shell with the argument allowlist.
- Tools never import each other's private modules. Conventional Commit headers; shared lint zero warnings, no rule-disable comments; `--help` unchanged.
- Versions are bumped only in the last commit: `npm-dep-upgrade-plan` 0.10.0 → 0.11.0, `npm-dep-upgrade` 0.8.0 → 0.9.0 (`package.json` and `package-lock.json` root metadata).
- Work in `worktrees/angular-runtime-strategy`. Tests per tool: `npm test` (and `npm run test:e2e` in upgrade with the runtimes from `tmp/e2e-env.sh`). Lint from the repo root: `npm --prefix dev-tooling run lint`. Scripted runners in unit tests must decode both Unix (`npm`, args array) and Windows (`npm.cmd <args>` string, empty args) launches.

## Review Focus

- Refactor fidelity: toolchain behavior and text unchanged after Tasks 1-4 (run the toolchain e2e scenarios and compare unit assertions, not just "tests pass").
- A finding with both a toolchain and a runtime choice: resolver order, the runtime search keeping the toolchain choice, `verifyResolution` for the second line judged against the original tree plus the first line's acceptance, and cross-line isolation (a runtime bump must not move `@angular/cli`/`@angular/build`, and the reverse; `@angular/build` has peers on `@angular/core` and `@angular/compiler-cli`).
- `nx migrate @angular/core@<v>` touching a toolchain package, or any package outside the runtime allowlist: aborts with `UNEXPECTED_MANIFEST_CHANGE` and reverts; a failed second pre-phase keeps the first phase's commit and names it.
- The `@angular/platform-browser-dynamic` override absent, present as a string, present in object form, and stale (no lockfile entry, nothing depends on it): never crashes the planner's resolver or the executor, and is updated only when present.
- Members split across fields (`@angular/compiler-cli` in `devDependencies`, the rest in `dependencies`), a missing optional member (for example no `@angular/forms`), and `@angular/core` missing: the strategy applies or does not apply without throwing.

## Intended commits

1. `refactor(upgrade-plan): drive the Angular toolchain strategy from a line config` (Task 1)
2. `refactor(upgrade-plan): make the scratch resolver and report line aware` (Task 2)
3. `refactor(upgrade): drive Angular toolchain validation from a line config` (Task 3)
4. `refactor(upgrade): run Angular line migrations as a list of pre-phases` (Task 4)
5. `feat(upgrade-plan): plan Angular runtime upgrades` (Task 5)
6. `feat(upgrade): migrate the Angular runtime` (Task 6)
7. `test(upgrade): cover the Angular runtime end to end` (Task 7)
8. `docs: document the Angular runtime strategy` (Task 8)
9. `chore: bump upgrade-plan and upgrade versions` (Task 9)

---

### Task 1: Planner line registry and line-parameterized helpers and planning

**Files:**
- Create: `tools/npm-dep-upgrade-plan/src/angular-lines.js`
- Rename (`git mv`) and edit: `src/toolchain.js` → `src/angular-line.js`; `src/toolchain-planning.js` → `src/angular-line-planning.js`; tests `test/toolchain.test.js` → `test/angular-line.test.js`, `test/toolchain-planning.test.js` → `test/angular-line-planning.test.js`, `test/toolchain-planning.integration.test.js` → `test/angular-line-planning.integration.test.js`
- Modify: `src/cli.js` (the toolchain loop after the parent loop), imports in `src/resolver-worker.js` (re-pointed in Task 2)
- Test: `test/angular-lines.test.js` (new), renamed tests above

**Interfaces:**
- Produces:
  - `angular-lines.js`: `export const ANGULAR_LINES` — an ordered array; this task holds exactly one entry `{ key: 'toolchain', strategy: 'upgrade-angular-toolchain', label: 'Upgrade Angular toolchain', anchor: '@angular/cli', members: ['@angular/cli', '@angular/build'], overrides: ['@angular-devkit/core'] }`; `export const lineOfStrategy = (strategy) => line | undefined`; `export const isLineChoice = (choice) => boolean`; `export const orderChoices = (choices) => choices` (line choices in registry order, then the rest in their given order).
  - `angular-line.js`: `lineMembers(line, manifest, lockPackages) -> { members: [{ name, location, version, requestedType }], version } | null` (anchor must be a root dependency, other members only when root-declared, all installed, one shared version — logic of today's `toolchainMembers`); `lineCandidateVersions(currentVersion, catalogVersions) -> string[]` (today's `toolchainCandidateVersions`); `inLineScope(consumerLocation, graph, members) -> boolean` (today's `inToolchainScope`).
  - `angular-line-planning.js`: `planLineChoices({ line, finding, row, project, options, controls, adapters }) -> Promise<{ freshAt }>` — today's `planToolchainChoices` with every Angular name read from `line`; it skips when `finding.choices` already holds a choice of `line.strategy`; the resolver input and the final `finding.choices` use `orderChoices`; catalog read is `adapters.readCatalog(line.anchor)`.
- Consumes: nothing new.

- [ ] **Step 1: Write failing tests:** `angular-lines.test.js` asserts the registry shape (one entry, exact values above), `lineOfStrategy('upgrade-angular-toolchain').key === 'toolchain'`, `lineOfStrategy('x') === undefined`, `isLineChoice` true for a toolchain choice and false for within-range/parent choices, and `orderChoices` puts line choices before parent and within-range choices while keeping the others' order. Rename the three toolchain test files and update their imports and call sites to the new names (`lineMembers(line, …)`, `lineCandidateVersions`, `inLineScope`, `planLineChoices({ line, … })`); do not change any assertion.
- [ ] **Step 2: Run** `cd tools/npm-dep-upgrade-plan && npm ci --ignore-scripts && node --test test/angular-lines.test.js test/angular-line.test.js test/angular-line-planning.test.js`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** the registry, `git mv` the two source files, parameterize them by `line` as specified, and replace the toolchain loop in `src/cli.js` with a loop over `ANGULAR_LINES` that calls `planLineChoices` after the parent loop (still one line, so behavior is identical). Keep exported names used by `resolver-worker.js` working until Task 2 (re-export `TOOLCHAIN_STRATEGY`/`TOOLCHAIN_MEMBERS` from `angular-lines.js` derived from the toolchain entry).
- [ ] **Step 4: Run** the renamed files, then `npm test` (with and without `tmp/e2e-env.sh` sourced) and lint from the repo root. Expected: PASS, assertions unchanged.
- [ ] **Step 5: Commit** — `git add -A tools/npm-dep-upgrade-plan && git commit -m "refactor(upgrade-plan): drive the Angular toolchain strategy from a line config"`

### Task 2: Planner scratch resolver and report become line aware

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/src/resolver-worker.js` (`isToolchain`, `isAncestor`, `memberEdges`, `verifyResolution`, `computeCoverage`'s `rootMember`, `toolchainManifest`, the toolchain branch of `resolveRequest`), `tools/npm-dep-upgrade-plan/src/report.js` (`TOOLCHAIN_STRATEGY`, `renderStrategies`)
- Test: `test/resolver-toolchain.test.js`, `test/resolver-toolchain.integration.test.js`, `test/report.test.js` (unchanged assertions); `test/angular-lines.test.js` gains the cases below

**Interfaces:**
- Consumes: `ANGULAR_LINES`, `lineOfStrategy`, `isLineChoice` from Task 1 (the worker stays standalone: it imports only `angular-lines.js`).
- Produces: in the worker, a line choice is recognized by `lineOfStrategy(choice.strategy)`; `lineManifest(manifest, choice, line)` rewrites every member the root declares (in the field that declares it) to `choice.targetVersion` and updates each existing override name in `line.overrides` (string or object-form `.`, same errors as today); `memberEdges(graph, line)` returns the root's edges to that line's members; `verifyResolution` takes the line of every line choice and checks, per line, that the members landed on the target and that the closures of the members before and after are in scope; `computeCoverage`'s root-member special case applies when the vulnerable package is a member of any registry line; `resolveRequest` requires line choices to occupy the first indexes (any other order throws `'Angular line choices must be resolved first'`) and judges each with `verifyResolution(before, after, item, [...accepted, choice], semver)`; `report.js` renders line transitions after parent transitions, in registry order, with the label from the registry (`Upgrade Angular toolchain: @angular/cli@X → @angular/cli@Y`).

- [ ] **Step 1: Write failing tests:** add to `angular-lines.test.js` an assertion that every `renderStrategies` label is read from the registry (call `renderMarkdown` with a toolchain choice and expect the unchanged cell text). The existing worker and report tests are the main safety net; update only imports and the error text assertion for a misplaced line choice (`/Angular line choices must be resolved first/`, previously `Toolchain choice must be resolved first`).
- [ ] **Step 2: Run** `node --test test/resolver-toolchain.test.js test/report.test.js test/angular-lines.test.js`. Expected: FAIL on the renamed message only.
- [ ] **Step 3: Implement** the line-aware worker and report as specified; the worker must not hard-code any Angular package name outside `angular-lines.js`.
- [ ] **Step 4: Run** `node --test test/resolver-toolchain.test.js test/resolver-toolchain.integration.test.js test/report.test.js` with `tmp/e2e-env.sh` sourced, then `npm test` and lint. Expected: PASS; no other assertion changed.
- [ ] **Step 5: Commit** — `git commit -am "refactor(upgrade-plan): make the scratch resolver and report line aware"`

### Task 3: Upgrade line registry, validation and release/manifest helpers

**Files:**
- Create: `tools/npm-dep-upgrade/src/angular-lines.js`
- Rename (`git mv`) and edit: `src/toolchain.js` → `src/angular-line.js`; `test/toolchain.test.js` → `test/angular-line.test.js`
- Modify: `src/model.js` (keep `TOOLCHAIN_STRATEGY`, derived from the registry), `src/planner.js` (`validatePlanner`, `selectItem`, `splitToolchain`)
- Test: `test/angular-lines.test.js` (new), `test/angular-line.test.js`, `test/planner.test.js`

**Interfaces:**
- Produces:
  - `angular-lines.js`: `export const ANGULAR_LINES` — ordered array; one entry for now: `{ key: 'toolchain', name: 'toolchain', strategy: 'upgrade-angular-toolchain', anchor: '@angular/cli', members: ['@angular/cli', '@angular/build'], overrides: ['@angular-devkit/core'], allowlist: ['@angular/cli', '@angular/build', '@angular-devkit/core', '@angular-devkit/schematics', '@schematics/angular', '@angular-devkit/architect'], unchecked: ['@angular-devkit/architect'], description: version => 'migrate Angular toolchain to ' + version }`; `lineOfStrategy(strategy)`.
  - `angular-line.js`: `selectLineRelease(line, choice, catalog, advisories, nowMs)` (today's `selectToolchainRelease`, error texts use `line.name` so the toolchain messages are unchanged); `checkManifestChanges(line, beforeManifest, afterManifest, version)` (allowlist and unchecked from the line); `setLineOverrides(line, manifestText, version) -> string | null` (updates every override in `line.overrides` that exists, preserving indent/CRLF/trailing newline; `null` when none exists; same object-form handling and `UNSUPPORTED_OVERRIDE` error).
  - `planner.js`: `validatePlanner` validates a line choice generically (`targetPackage === line.anchor`, `targetLocation === 'node_modules/' + line.anchor`, valid same-major upward versions, at most one per line, error text for the toolchain unchanged); `splitLines(item) -> { lines: [{ line, choice }], rest }` (execution order = registry order; `rest.choices` keeps the others' order; more than one choice of a line is `INVALID_PLAN`); `splitToolchain` is removed.
- Consumes: nothing from the planner tool.

- [ ] **Step 1: Write failing tests:** `angular-lines.test.js` (registry shape and `lineOfStrategy`); rename and port `toolchain.test.js` and the toolchain cases in `planner.test.js` to the new signatures without changing any assertion value; add `splitLines` cases (no line choice → `{ lines: [], rest: item }`; a toolchain choice plus parent and within-range choices → one line entry and `rest` in original order; two toolchain choices → `INVALID_PLAN`).
- [ ] **Step 2: Run** `cd tools/npm-dep-upgrade && npm ci --ignore-scripts && node --test test/angular-lines.test.js test/angular-line.test.js test/planner.test.js`. Expected: FAIL (modules or functions missing).
- [ ] **Step 3: Implement** the registry, the renames and the generic validation/split. `toolchain-migration.js` and `cli.js` keep working through temporary adapters (`selectToolchainRelease = (...a) => selectLineRelease(TOOLCHAIN_LINE, ...a)` etc. in the call sites) until Task 4.
- [ ] **Step 4: Run** the three files, then `npm test` and lint. Expected: PASS, assertions unchanged.
- [ ] **Step 5: Commit** — `git add -A tools/npm-dep-upgrade && git commit -m "refactor(upgrade): drive Angular toolchain validation from a line config"`

### Task 4: Upgrade executor and CLI run line migrations as pre-phases

**Files:**
- Rename (`git mv`) and edit: `tools/npm-dep-upgrade/src/toolchain-migration.js` → `src/angular-line-migration.js`; `test/toolchain-migration.test.js` → `test/angular-line-migration.test.js`
- Modify: `src/cli.js` (the toolchain phase and recovery messages), `src/git.js` (`assertCleanWorkingTree` message wording only if it names the toolchain), `test/cli.test.js`
- Test: renamed tests; `test/cli.test.js`

**Interfaces:**
- Consumes: `ANGULAR_LINES`, `selectLineRelease`, `checkManifestChanges`, `setLineOverrides`, `splitLines` from Task 3.
- Produces:
  - `migrateLine({ line, guard, project, item, choice, context, options, adapters }) -> Promise<{ commit, action }>` — today's `migrateToolchain` driven by `line`: the `nx migrate` argument is `${line.anchor}@${version}`, the version/age/catalog/advisories come from the anchor, the commit description is `line.description(version)`, `strategy` is `line.strategy`, the post-install lockfile check reads `packages[choice.targetLocation].version`, and every user-facing message that says "toolchain" uses `line.name` so the toolchain text is unchanged. All safety behavior (clean tree, `migrations.json`, allowlist, install fallback, narrowed revert, guard update after the commit) is unchanged.
  - `cli.js`: replaces `splitToolchain`/`migrateToolchain` with `splitLines` and a dependency `migrateLine`; runs each `{ line, choice }` in order as its own pre-phase: `stage = line.name`, migrate, refresh project and graph, check the target installation, trim consumers as today; keeps every completed phase's commit in `lineCommits` for failure messages (`completed commits: …` lists all of them); actions and `commits[].actionIndex` follow the combined order (line phases in order, then the remaining choices). With one toolchain choice, stdout, stderr, commits and exit codes are byte-identical to today.

- [ ] **Step 1: Write failing tests:** port the migration tests (rename, update the call to `migrateLine({ line, … })`, assertions unchanged) and the CLI tests (stub dependency renamed to `migrateLine`, assertions unchanged). Add CLI cases with a synthetic second line injected through a `lines` dependency override (`d.lines`, default `ANGULAR_LINES`): two line choices run in registry order, two commits, `actionIndex` `[0, 1, …]`; a failure in the second phase keeps and names the first commit and does not restore over it; the target gone after the first phase skips the second phase's evidence and reports the remaining choices `already-satisfied`.
- [ ] **Step 2: Run** `node --test test/angular-line-migration.test.js test/cli.test.js`. Expected: FAIL (modules or dependency names missing).
- [ ] **Step 3: Implement** `migrateLine` by renaming and parameterizing the executor, and the pre-phase loop in `cli.js` with the injectable `lines` dependency.
- [ ] **Step 4: Run** `npm test`, then `npm run test:e2e` with `tmp/e2e-env.sh` sourced (the existing toolchain e2e scenarios pass unchanged), and lint. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A tools/npm-dep-upgrade && git commit -m "refactor(upgrade): run Angular line migrations as a list of pre-phases"`

### Task 5: Planner runtime line

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/src/angular-lines.js` (add the entry), `src/angular-line-planning.js` (only if tests expose a gap), `src/resolver-worker.js` (only if tests expose a gap), `src/cli.js`
- Test: `test/angular-lines.test.js`, `test/angular-line.test.js`, `test/angular-line-planning.test.js`, `test/resolver-runtime.test.js` (new), `test/resolver-runtime.integration.test.js` (new, model on `resolver-toolchain.integration.test.js`), `test/angular-line-planning.integration.test.js`, `test/report.test.js`, `test/schema3.test.js`

**Interfaces:**
- Produces: registry entry appended after toolchain: `{ key: 'runtime', strategy: 'upgrade-angular-runtime', label: 'Upgrade Angular runtime', anchor: '@angular/core', members: ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router'], overrides: ['@angular/platform-browser-dynamic'] }`. The planner loop in `cli.js` visits lines in registry order, so a finding is planned for toolchain then runtime, each keeping the earlier choices; final `finding.choices` is ordered with `orderChoices` (toolchain, runtime, parents, within-range).

- [ ] **Step 1: Write failing tests:** registry has two entries in order; `lineMembers(runtime, …)` returns the seven members across `dependencies` and `devDependencies` (compiler-cli), returns `null` when `@angular/core` is not a root dependency or member versions differ, tolerates a missing optional member; planning: a depth-1 and a depth-2 child cleared by the lowest same-major `@angular/core` version with no age filter, the vulnerable package being `@angular/core` itself (root consumer), a finding that already has a toolchain choice keeps it and gains a runtime choice (resolver stub receives `[toolchain, runtime, …]` in that order), a runtime-only finding, `freshAt` bounded by the `@angular/core` catalog; resolver (unit and integration, both npm runtimes): members rewritten in their own fields, `@angular/platform-browser-dynamic` updated only when present (string, object-form, absent, stale entry with no lock entry), a runtime bump does not move `@angular/cli`/`@angular/build` and a toolchain bump does not move runtime packages, mixed runtime + within-range choice, runtime second after toolchain first; report: `Upgrade Angular runtime: @angular/core@21.2.25 → @angular/core@21.2.26`, ordering parent → toolchain → runtime; JSON carries the choice with `targetPackage: "@angular/core"` and `schemaVersion: 3`.
- [ ] **Step 2: Run** the new and extended test files. Expected: FAIL (no runtime entry).
- [ ] **Step 3: Implement** the registry entry and any fixes the tests expose in planning or the worker (for example per-line `verifyResolution` closure handling with two accepted line choices); no new Angular name outside the registry.
- [ ] **Step 4: Run** `npm test` with `tmp/e2e-env.sh` sourced, plus lint. Expected: PASS; existing toolchain tests unchanged.
- [ ] **Step 5: Commit** — `git add -A tools/npm-dep-upgrade-plan && git commit -m "feat(upgrade-plan): plan Angular runtime upgrades"`

### Task 6: Upgrade runtime line

**Files:**
- Modify: `tools/npm-dep-upgrade/src/angular-lines.js`, `src/angular-line.js` / `src/angular-line-migration.js` / `src/cli.js` only if tests expose a gap
- Test: `test/angular-lines.test.js`, `test/angular-line.test.js`, `test/planner.test.js`, `test/angular-line-migration.test.js`, `test/cli.test.js`

**Interfaces:**
- Produces: registry entry after toolchain: `{ key: 'runtime', name: 'runtime', strategy: 'upgrade-angular-runtime', anchor: '@angular/core', members: <the seven>, overrides: ['@angular/platform-browser-dynamic'], allowlist: <the seven> + '@angular/platform-browser-dynamic', unchecked: [], description: version => 'bump Angular runtime to ' + version }`.

- [ ] **Step 1: Write failing tests:** validation accepts a runtime choice (`targetPackage` `@angular/core`, location `node_modules/@angular/core`, same major) and rejects a runtime choice with `targetPackage` `@angular/cli`, a different major, or a second runtime choice; `selectLineRelease` uses `@angular/core` release times (planned release used if eligible, otherwise lowest newer same-major eligible, `RELEASE_AGE`/`NO_CANDIDATE` codes); `checkManifestChanges(runtime, …)` passes with the seven members and the override at the target, fails when `@angular/cli`, `@angular/build` or an eighth package changes, when a member is at another version, or when the override is changed to another version (no unchecked member); `setLineOverrides` updates the override only when present (string, object-form `.`, absent returns `null`, CRLF/indent/trailing newline preserved); migration happy path with `platform` `win32` and `linux` produces subject `deps(webapp): bump Angular runtime to <v>` with `npx --no nx migrate @angular/core@<v>`; `migrations.json` aborts and reverts; the migration of a toolchain choice plus a runtime choice runs both pre-phases in order (two commits), and a failure in the runtime phase keeps and names the toolchain commit.
- [ ] **Step 2: Run** the listed files. Expected: FAIL (no runtime entry).
- [ ] **Step 3: Implement** the registry entry and any fixes the tests expose; do not add Angular names outside the registry.
- [ ] **Step 4: Run** `npm test` and lint. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A tools/npm-dep-upgrade && git commit -m "feat(upgrade): migrate the Angular runtime"`

### Task 7: End-to-end coverage

**Files:**
- Create: `tools/npm-dep-upgrade/test/e2e/runtime.test.js`, `tools/npm-dep-upgrade/test/e2e/fixtures/runtime.js`
- Modify: `tools/npm-dep-upgrade/test/e2e/COVERAGE.md`; the fake `nx` helper in `test/e2e/helpers/` (generalize its `migrate` handler to rewrite the members of the line named by the argument package)

**Interfaces:**
- Consumes: `createProject`, `plan`, `runUpgrade` and the toolchain e2e fixture/test as the model.

- [ ] **Step 1: Write failing tests** for each runtime in `runtimes`: exact-pinned runtime members (compiler-cli in `devDependencies`) plus a stale `@angular/platform-browser-dynamic` override and a vulnerable depth-2 child fixed in the next patch of the runtime; plan reports `complete` with a runtime choice; upgrade exits 0 with one commit `deps: bump Angular runtime to <v>` and with `--module webapp` the subject `deps(webapp): bump Angular runtime to <v>`; members and the override at `<v>`; a `migrations.json` variant exits 1 with `git status --porcelain` empty and HEAD unchanged; a release that became younger than 7 days after planning exits 1 with no change; a finding with both a toolchain and a runtime choice yields two commits, toolchain first; a fake `nx` that also edits `@angular/cli` exits 1 and reverts.
- [ ] **Step 2: Run** `source tmp/e2e-env.sh && cd tools/npm-dep-upgrade && npm run test:e2e -- --test-name-pattern runtime`. Expected: FAIL.
- [ ] **Step 3: Implement** the fixtures and helper changes; fix any product defect the scenarios expose in the owning module with a unit test first, as a separate preceding commit.
- [ ] **Step 4: Run** `npm test`, `npm run test:e2e` (both runtimes) and lint. Expected: PASS, toolchain scenarios unchanged.
- [ ] **Step 5: Commit** — `git add -A tools/npm-dep-upgrade && git commit -m "test(upgrade): cover the Angular runtime end to end"`

### Task 8: Documentation

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/README.md`, `tools/npm-dep-upgrade/README.md`, `README.md` (if it lists strategies), `AGENTS.md`

- [ ] **Step 1: Update the planner README:** generalize the "Angular toolchain" section into "Angular lines" with a toolchain and a runtime subsection (members, anchor, override, label, Markdown cell text, JSON choice example for `@angular/core`, order within-range → parent → toolchain → runtime, no age filter).
- [ ] **Step 2: Update the upgrade README:** the flow per line, the runtime allowlist (no unchecked member), the `@angular/platform-browser-dynamic` override rule, the command and commit subject, release age on `@angular/core`, execution order toolchain → runtime → parent → within-range, failure of a later phase keeping earlier commits.
- [ ] **Step 3: Update AGENTS.md:** one line each in the planner and upgrade sections for the runtime line and the ordering.
- [ ] **Step 4: Verify** each statement against the source, then `git diff --check`.
- [ ] **Step 5: Commit** — `git commit -am "docs: document the Angular runtime strategy"`

### Task 9: Version bump

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/package.json`, `package-lock.json`, `tools/npm-dep-upgrade/package.json`, `package-lock.json`

- [ ] **Step 1: Set** `npm-dep-upgrade-plan` 0.10.0 → 0.11.0 and `npm-dep-upgrade` 0.8.0 → 0.9.0 in each `package.json` and the root `version` plus `packages[""].version` of each `package-lock.json`; grep `tools/` for other hard-coded copies of the old versions.
- [ ] **Step 2: Verify:** `npm test` in both tools, `npm run test:e2e` in upgrade (both runtimes), lint from the repo root, and `node bin/<tool>.js --version` prints the new versions.
- [ ] **Step 3: Commit** — `git commit -am "chore: bump upgrade-plan and upgrade versions"`
