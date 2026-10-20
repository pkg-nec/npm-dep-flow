# npm-dep-upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every planner finding a deterministic hash ID and add a CLI that upgrades exactly one selected installation, removes temporary overrides, verifies the result, and commits the dependency files.

**Architecture:** Keep the planner and mutator as independent tools exchanging public schema version 2 CLI reports. The mutator combines fresh planner/audit/paths evidence, registry candidate checks, reversible manifest edits, actual npm installs, dependency-graph validation, and a final Git commit. Pure selection, scope, and graph decisions are tested separately from the real npm/registry/Git E2E suite.

**Tech Stack:** Node.js 24.21.0 reference runtime; ES modules; `node:test`; npm 12.1.0 default and 11.10.0 compatibility; direct dependencies `semver@7.8.5`, `@npmcli/arborist@10.0.3`, `@npmcli/config@11.1.0`, and `npm-registry-fetch@20.0.1`. Use only documented public APIs from directly declared dependencies; do not import a global npm installation's modules.

**Spec:** [Approved design](../specs/2026-10-20-npm-dep-upgrade-design.md) and [E2E catalog with final addendum](../specs/2026-10-20-npm-dep-upgrade-e2e-cases.md). Read the addendum before the original F03–F05 expectations.

## Global Constraints

- Only `update-within-declared-range` is supported. Parent upgrades, forcing versions outside original requirements, exact-pinned direct dependencies, batch execution, orchestration, pushing commits, and additional remediation strategies are excluded.
- The project root is the caller's current directory. The command is `npm-dep-upgrade <id-or-prefix> [--package <name>] [--format markdown|json]`; help and version work without a project. No `--to`, saved-plan input, or item-number selector.
- IDs are lowercase hexadecimal SHA-256 of UTF-8 `package + "__" + targetLocation`; JSON contains all 64 characters, Markdown the first seven. Accept lowercase hexadecimal selectors between 7 and 64 characters.
- Retain existing schema version 2 fields and semantics; planner `id` is additive. Do not change the planner's minimum-safe version policy to newest-version selection.
- Choose the newest stable, safe, verifiably at-least-seven-day-old candidate satisfying every original incoming requirement, newer than installed, and at least the minimum-safe bound.
- Preserve literal direct `^`/`~` operators and sections, including compatible repeated declarations. Use approved parent-preserving scoped temporary overrides for transitive application, then remove them and reinstall.
- All installation subprocesses explicitly use `--ignore-scripts` and `--min-release-age=7`; do not relax stricter effective policies. Do not run lifecycle scripts.
- Require clean tracked nonsymlink dependency files, an empty repository-wide staging area, a branch with existing HEAD, no in-progress Git operation, and usable author/committer identity.
- One invocation changes one selected installation. Required supporting dependencies may change; other installations of the selected package and unexplained unrelated packages may not.
- Verify uncached advisories before acceptance and after cleanup. A stale recommendation fails without silently selecting another candidate or creating a commit.
- Commit only changed project dependency files using `deps: bump <package-name> from <old-version> to <new-version>`; no push, amend, or release tag.
- Keep sibling CLIs independent. Do not import their private source or create a root npm package/workspace. The three existing analysis tools remain read-only.
- Support single-package registry-backed npm projects and lockfile versions 2/3; preserve existing exclusions for workspaces, local dependencies/links, shrinkwrap, and other package managers.
- Reference Node.js is 24.21.0. The new package's Node engine matches its direct npm-library dependencies: `^22.22.2 || ^24.15.0 || >=26.0.0`. Existing tools' engine declarations remain unchanged.
- Scratch roots: `/home/maw/src/nrc/npm-dep-flow-impl/tmp/`. Execution worktrees: `/home/maw/src/nrc/npm-dep-flow-impl/worktrees/`. Preserve the original temporary test draft.
- Version bumps happen together in the final planned release-metadata commit: planner 0.2.2 → 0.3.0; new mutator development version 0.0.0 → initial release 0.1.0. Keep each package and lockfile's root metadata in sync.

## Review Focus

- A scoped package's slash must remain part of its name, not an extra installation segment; Task 1 and Task 4 test canonical locations, scoped IDs, containment, and invalid alternate spellings.
- A newer candidate can have an advisory that does not affect the installed old version; Task 5 queries candidate advisories and tests this independently of installed-version audit rows.
- One physical target may have several root declarations and parent links; Tasks 4 and 6 retain all original requirements and reject an exact-pin conflict instead of forcing or splitting the installation.
- Supporting dependencies may already be shared with unrelated consumers; Task 7 tests both allowed closure changes and a shared-node change that violates an outside consumer or alters another target copy.
- Git hooks and concurrent user actions can change files/index/HEAD after preflight; Tasks 3 and 8 distinguish operation-owned recovery from verified-but-uncommitted commit failures and never reset user work.

---

## Workspace, file map, and shared contracts

Continue in `/home/maw/src/nrc/npm-dep-flow-impl/worktrees/npm-dep-upgrade-design` on its existing local branch unless the user requests another execution worktree. Do not reuse unrelated worktrees or check out `main` for implementation. Planning/documentation commits are not product implementation commits.

Planner files: add `tools/npm-dep-upgrade-plan/src/ids.js`; modify its `src/report.js`, focused tests, README, and final package metadata. Keep current strategy/evaluation semantics intact.

New tool file map (all relative to `tools/npm-dep-upgrade/`):

| Files | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json`, `bin/npm-dep-upgrade.js` | Independent package, exact direct dependency pins, executable entry point. |
| `src/args.js`, `src/errors.js`, `src/model.js` | CLI parsing, stage-aware errors, JSDoc contracts and constants. |
| `src/process.js` | Portable bounded subprocess execution, progress routing, credential-safe diagnostics. |
| `src/project.js`, `src/graph.js` | Supported-project validation; read-only lock/installed graph snapshots through public Arborist APIs. |
| `src/planner.js`, `src/evidence.js` | Public report adapters, hash validation/selection, fresh incoming/advisory evidence. |
| `src/npm-context.js`, `src/registry.js`, `src/candidates.js` | Effective npm configuration, authenticated metadata/security queries, pure version selection. |
| `src/git.js`, `src/recovery.js` | Preflight/index/HEAD checks, file ownership/snapshots, controlled staging/commit/recovery. |
| `src/scopes.js`, `src/mutation.js`, `src/installer.js` | Scope impact checks, reversible manifest changes, required npm install flags. |
| `src/verify.js`, `src/report.js`, `src/cli.js` | Post-install invariants, completed output, transaction orchestration. |
| `test/*.test.js`, `test/helpers/` | Focused unit/adapter/integration tests; modules mirror source ownership. |
| `test/e2e/*.test.js`, `test/e2e/helpers/`, `test/e2e/fixtures/` | Deterministic registry, tarballs, real CLI/Git runner, catalog cases, fixed collision data. |
| `README.md` | Runtime requirements, CLI, ID rules, mutation/commit/recovery behavior, development commands. |

Do not build a generic plugin, strategy registry, orchestration engine, or arbitrary JSON editor. Use focused modules with injected adapters for tests.

Define these JSDoc types in `src/model.js`; all later tasks consume them:

- `Options = { selector: string|null, packageName: string|null, format: 'markdown'|'json', action: 'upgrade'|'help'|'version' }`.
- `PlanRow` retains the planner schema fields and adds full `id`; `SelectedItem` is a validated eligible `PlanRow` for `update-within-declared-range`.
- `Project = { root, manifest, lock, manifestBytes, lockBytes }`, where `root` is absolute, bytes are Buffers, and lock has a validated `packages` map.
- `Graph = { nodes: Map<string, GraphNode>, edges: GraphEdge[] }`; node key/location is `''` for root or canonical project-relative location. `GraphNode = { location, name, version, resolved: string|null, integrity: string|null }`; `GraphEdge = { from, to: string|null, requestedName, type, rawSpec, effectiveSpec, optional, valid }`. Dependency `type` uses manifest field names. Preserve every root declaration even if Arborist coalesces its effective edges.
- `Evidence = { item, auditRows, graph, incoming: GraphEdge[], directDeclarations: { field, requestedName, spec }[], upstream: { nodes, edges }[] }`. `upstream` is validated public paths data for distinct transitive parent identities.
- `Candidate = { version, releasedAt }`; `NpmContext = { version, registry, auditRegistry, requestOptions, installArgs }`. `requestOptions` can contain secrets: never render or stringify the context.
- `Guard = { repoRoot, projectPrefix, head, branch, dependencyPaths, originalFiles, ownedFiles }`. Git paths are repository-relative, original files are Buffers, and owned-file entries record the latest operation-authored/observed bytes for safe recovery.
- `Mutation = { kind: 'direct'|'transitive', applyBytes: Buffer, cleanupBytes: Buffer|null, scopedLocations: string[] }`; direct cleanup is null, transitive cleanup restores original root bytes after removing introduced rules.
- `SupportingChange = { package, oldLocation: string|null, newLocation: string|null, oldVersion: string|null, newVersion: string|null }`.
- `UpgradeResult = { schemaVersion: 2, id, package, oldVersion, newVersion, targetLocation, strategy, releasedAt, changedFiles: string[], supportingChanges: SupportingChange[], commit: { hash, subject } }`.
- `UpgradeError` exposes `code`, `stage`, `message`, and optional recovery facts `filesRestored`, `installedTreeMayHaveChanged`, and `changesRemainUncommitted`. Errors never carry secret npm request options into rendered output.

## Intended implementation commits

| Task | Commit subject | Contents |
| --- | --- | --- |
| 1 | `feat(upgrade-plan): add deterministic finding IDs` | Planner ID column/field and contract tests, no version bump. |
| 2 | `feat(upgrade): add CLI contracts and process adapters` | Independent package, parser, executable shell, model/errors, bounded subprocess adapter. |
| 3 | `feat(upgrade): guard Git state and dependency-file recovery` | Preflight, file snapshots/ownership, early-refusal and recovery tests. |
| 4 | `feat(upgrade): select fresh planner targets and requirements` | Project/graph/public report adapters and exact target validation. |
| 5 | `feat(upgrade): select safe releases with age checks` | Configuration, registry security, newest-candidate policy. |
| 6 | `feat(upgrade): apply reversible scoped dependency changes` | Direct edits, override scope/cleanup, real install wrapper. |
| 7 | `feat(upgrade): verify target isolation and supporting changes` | Semantic graph diff, exact target/cleanup constraints, fresh final security gate. |
| 8 | `feat(upgrade): commit verified single-target upgrades` | Transaction CLI, output, commit/hook/concurrent-state handling. |
| 9 | `test(upgrade): add deterministic registry and Git fixtures` | Real tarball/registry/audit harness and one real success smoke case. |
| 10 | `test(upgrade): cover eligible targets and hash selection` | Success/range/scope/collision/supporting-change catalog coverage. |
| 11 | `test(upgrade): cover stale recommendations and recovery` | Negative/advisory/Git/failure/catalog matrix and repeatability. |
| 12 | `docs(upgrade): document runtime and automated verification` | Tool/repository guides, CI workflow, full required verification. |
| 13 | `chore: set dependency upgrade release versions` | All planner/new-tool release version metadata together, once. |

### Task 1: Add deterministic IDs to the planner's public reports

**Files:** Create `tools/npm-dep-upgrade-plan/src/ids.js`, `test/ids.test.js`; modify `src/report.js`, `test/report.test.js`, `test/cli.test.js`, `test/audit.integration.test.js`, and `README.md` under that tool.

**Interfaces:** Produce `findingId(packageName: string, targetLocation: string) -> string` using `node:crypto`. `renderJson` and `renderMarkdown` retain their signatures; both derive the ID from each row's package/location so no sibling consumer depends on a private evaluator field.

- [ ] **Step 1 — Failing tests:** Assert `findingId('brace-expansion', 'node_modules/minimatch/node_modules/brace-expansion') === createHash('sha256').update('brace-expansion__node_modules/minimatch/node_modules/brace-expansion', 'utf8').digest('hex')`; changing only installed version or row order cannot change this ID. Assert 64 lowercase characters in every JSON row, including ineligible rows, and the matching seven-character ID column in Markdown. Include scoped names, distinct locations, empty report, existing escaping, and unchanged minimum-safe/strategy values.
- [ ] **Step 2 — Red:** From the planner directory run `node --test test/ids.test.js test/report.test.js`; expect missing helper/ID assertions to fail. Update only report fixture expectations needed by the additive field; do not weaken old-field assertions.
- [ ] **Step 3 — Implement:** Add the pure hash helper and wire it into the two renderers. Keep sort order, schemaVersion 2, empty output, and strategy selection unchanged. Project-derived target locations must be canonical; renderer escaping tests may use synthetic strings without making them acceptable mutator inputs.
- [ ] **Step 4 — Green:** Run `npm test` in the planner directory, and its existing audit integration with the installed audit CLI when available. Assert the Markdown and JSON IDs refer to the same rows.
- [ ] **Step 5 — Commit:** Commit the named Task 1 files using its intended subject. Do not change package versions.

### Task 2: Establish the new package, parser, and portable process contract

**Files:** Create new-tool manifests, `src/model.js`, `src/errors.js`, `src/args.js`, `src/process.js`, `test/args.test.js`, and `test/process.test.js`. The bin mapping is declared now; Task 8 creates the executable it names.

**Interfaces:** Produce `parseArgs(argv: string[]) -> Options`; `UpgradeError(code, stage, message, recovery = {})`; `runProcess(command: string, args: string[], options: { cwd, env?, platform?, spawnImpl?, onStderr?, maxBytes? }) -> Promise<{ code, stdout, stderr }>`; default combined capture limit is 32 MiB.

- [ ] **Step 1 — Package setup:** Create development version 0.0.0 with `private: true`, `type: module`, approved engine range, bin mapping, `test: node --test test/*.test.js`, and `test:e2e: node --test test/e2e/*.test.js`. Pin the four dependencies in Tech Stack. Generate its lockfile with `npm install --package-lock-only --ignore-scripts`, then `npm ci --ignore-scripts` inside the new tool only. Use the approved tmp/cache directories; do not install dependencies into the repository root or target fixtures yet.
- [ ] **Step 2 — Failing tests:** Assert a seven-character or full lowercase selector, exact scoped `--package`, optional flag order, Markdown default, JSON format, and help/version without project access. Reject selectors of 6/65 characters, uppercase/nonhex characters, extra positionals, `--to`, `--item`, `--plan`, unknown options, and missing option values. Process tests assert argument-array Unix launching; safely quoted `.cmd` launching on Windows; `cwd` never interpolated into shell text; Git uses its executable rather than a fabricated `git.cmd`; reject spawn errors, oversized output, and null/abnormal exit.
- [ ] **Step 3 — Red:** Run `node --test test/args.test.js test/process.test.js`; expect missing module/behavior failures.
- [ ] **Step 4 — Implement:** Add shared contracts/errors, parser and process adapter. On Windows quote/escape validated argument tokens instead of copying the sibling runner's simple string join for Git subjects or path arguments. Do not log environment/configuration. Parser tests prove help/version actions need no project; the actual executable and completed command behavior are introduced together in Task 8.
- [ ] **Step 5 — Green/commit:** Run the focused tests and `npm test`; commit Task 2 files. Keep version 0.0.0 until Task 13.

### Task 3: Enforce Git preconditions and operation-owned recovery

**Files:** Create `src/git.js`, `src/recovery.js`, `test/git.test.js`, `test/recovery.test.js`, and `test/helpers/git-project.js`.

**Interfaces:** Consume `runProcess`, `UpgradeError`, and shared types. Produce `preflightGit(projectRoot, io = {}) -> Promise<Guard>`; `assertGitState(guard, phase: 'before-write'|'before-commit', expectedFiles) -> Promise<void>`; `recordOwnedFiles(guard, files) -> Promise<void>`; `restoreDependencyFiles(guard) -> Promise<{ filesRestored, installedTreeMayHaveChanged }>`.

- [ ] **Step 1 — Failing tests:** Use real temporary Git repositories with local fixture identity and no external hooks. For G01/G02/G07, assert refusal for dirty/untracked/symlink dependency files, any staged path including paths outside a nested project, detached/unborn HEAD, Git operations in progress, and missing identity. Assert unrelated unstaged/untracked files survive. For recovery, exact original dependency bytes are restored only when current bytes still equal operation-owned state; a new user edit or HEAD/index change is preserved and produces a diagnostic. No test may accept `git reset --hard`, blanket checkout/restore, or an implicit stash.
- [ ] **Step 2 — Red:** Run `node --test test/git.test.js test/recovery.test.js`; expect missing implementations.
- [ ] **Step 3 — Implement:** Resolve repository-relative project paths using Git's NUL-safe output; inspect the entire index, both dependency files, HEAD/branch and `git var` identity without printing identity/config unnecessarily. Use Git's actual operation paths, which work in linked worktrees. Capture file bytes and HEAD before mutation. Ownership records change only after controlled writes or an inspected install result. Refuse to overwrite an unrecognized concurrent edit during recovery.
- [ ] **Step 4 — Green:** Run the two focused suites and `npm test`. Confirm each negative case leaves HEAD/index and unrelated file bytes unchanged.
- [ ] **Step 5 — Commit:** Commit Task 3 deliverable; no release changes.

### Task 4: Validate current projects and select one fresh planner installation

**Files:** Create `src/project.js`, `src/graph.js`, `src/planner.js`, `src/evidence.js`, corresponding `test/project.test.js`, `graph.test.js`, `planner.test.js`, and `evidence.test.js`.

**Interfaces:** Produce `loadProject(root) -> Promise<Project>`; `loadGraph(projectRoot, { actual?: boolean } = {}) -> Promise<Graph>`; `readPlanner(root, run = runProcess) -> Promise<{ schemaVersion: 2, auditedAt, rows: PlanRow[] }>`; `selectItem(report, selector, packageName) -> SelectedItem`; `readEvidence(project, item, run = runProcess) -> Promise<Evidence>`.

- [ ] **Step 1 — Failing tests:** Cover H01/H02/H05 validation, recomputed full IDs, duplicate IDs, package filter before ambiguity checking, zero matches, ineligible/unknown strategies, and stale current name/version/location. Reject absolute paths, traversal, backslashes, empty target location, `./`, malformed scoped segments and path escapes. Preserve an empty parent location for the root, scoped names, all compatible root declarations, and all incoming edges to a shared target; an exact pin must not disappear during normalization. Include unsupported workspaces/file/link/shrinkwrap/package-manager and inconsistent lock root metadata.
- [ ] **Step 2 — Red:** Run the four focused test files; expect missing imports or assertions.
- [ ] **Step 3 — Implement graph/project adapters:** Use directly declared public `Arborist.loadVirtual()` for lock graph normalization; never call its write/reify methods. Use `loadActual()` only for read-only installed-state checks. Preserve both raw and effective requirements plus all root declarations, and compare required target files with lock state. Validate project/path containment with filesystem checks rather than blindly joining untrusted report locations. Follow existing project restriction behavior without importing sibling source.
- [ ] **Step 4 — Implement public evidence adapters:** Launch `npm-dep-upgrade-plan . --format json`; validate every row before selection and recompute IDs locally using the approved formula. Launch `npm-dep-audit . --min-severity info --no-cache --format json`. For each distinct transitive parent identity, use `npm-dep-paths . <package>@<old-version> --upstream-of <parent>@<version> --format json`; validate schema v2 summary/upstream data and retain only the selected location's relevant links/routes. Direct root declarations come from the manifest as well as public evidence. Require the fresh audit, graph, and selected row to agree.
- [ ] **Step 5 — Green/commit:** Run all four focused suites and `npm test`; commit Task 4 files. Unit tests may fake CLI adapters, but the final E2E suite must exercise real sibling commands.

### Task 5: Load effective npm context and select the newest safe aged candidate

**Files:** Create `src/npm-context.js`, `src/registry.js`, `src/candidates.js`, `test/npm-context.test.js`, `registry.test.js`, and `candidates.test.js`.

**Interfaces:** Produce `loadNpmContext(projectRoot, deps = {}) -> Promise<NpmContext>`; `readCatalog(projectRoot, packageName, context) -> Promise<{ versions: string[], releaseTimes: Map<string,string> }>`; `readCandidateAdvisories(packageVersions: Map<string,string[]>, context) -> Promise<Map<string,{ id, range }[]>>`; `selectCandidate(item, requirements: string[], catalog, advisories, nowMs: number) -> Candidate`.

- [ ] **Step 1 — Failing tests:** Cover R01–R05, scalar `npm view versions`, noncanonical/prerelease rejection, invalid timestamps, later versions published earlier, multiple advisory ranges and ranges affecting candidates but not the installed version. Assert newest 6.0.12 wins over safe 6.0.10, ^ can choose old-enough 6.1.0 while ~ cannot, and no 7.x escapes either range. A controlled-clock test checks exactly seven days, one millisecond too young, and future timestamps. Test scoped registry/auth, user/project/global precedence, configured audit registry, stricter effective release-age/before restrictions, failed/malformed security responses, and credential redaction.
- [ ] **Step 2 — Red:** Run the three focused suites; expect missing module/function failures.
- [ ] **Step 3 — Implement context:** Use public `@npmcli/config` and its documented definitions/flatten APIs with isolated argv rather than this tool's selector flags. Resolve the selected npm executable/package root only to load its documented builtin npmrc/package metadata; do not require its private modules. Read npm version and effective nonsecret registry context through the selected npm. Validate that library-loaded registry/scoped/auth context agrees with effective npm configuration. If the npm root/configuration cannot be determined consistently, fail before mutation rather than guessing another registry. Build install argv with explicit `--ignore-scripts --min-release-age=7`, preserving any stronger configured age as the explicit age and any stricter absolute before policy. Never export or render auth options.
- [ ] **Step 4 — Implement adapters/evaluator:** Query `npm view <name> versions --json --prefer-online` and `npm view <name> time --json --prefer-online` through the public CLI so a setup/planner cache does not hide a newer catalog. For safety query `POST /-/npm/v1/security/advisories/bulk` with candidate package/version lists via directly declared `npm-registry-fetch`; use the effective audit registry and credentials, fresh responses, bounded output and validated advisory semver ranges. Select using descending strict stable order, all original requirements, minimum-safe lower bound, fresh advisory exclusions and effective age/cutoff checks. No acceptable candidate is an error before installation; no fallback to a vulnerable candidate, another strategy or public registry.
- [ ] **Step 5 — Green/commit:** Run focused suites and `npm test`; commit Task 5. Keep dependency pins and package versions unchanged.

### Task 6: Build reversible direct edits and narrow transitive override scopes

**Files:** Create `src/scopes.js`, `src/mutation.js`, `src/installer.js`, `test/scopes.test.js`, `mutation.test.js`, and `installer.test.js`.

**Interfaces:** Produce `createScopeProbe(project, scratchRoot) -> Promise<probeScope>` and `planScopes(project, evidence, candidate, { probeScope }) -> Promise<{ overrides, scopedLocations: string[] }>` in `src/scopes.js`; `buildMutation(project, evidence, candidate, deps = {}) -> Promise<Mutation>` and `writeMutation(projectRoot, bytes: Buffer, guard) -> Promise<void>` in `src/mutation.js`; `installProject(projectRoot, context, io) -> Promise<void>` in `src/installer.js`. The returned `probeScope(overrides) -> Promise<{ affectedEdges: GraphEdge[], changedParentSpecs: GraphEdge[] }>` evaluates override effects in a scratch virtual project, without installing in the target.

- [ ] **Step 1 — Failing tests:** Cover D01–D04 and T01–T08/O01–O04. Assert exact operator/section preservation, root duplicate declarations, unsupported exact direct pins, direct parent `".": "$package-a"`, nonroot parents without invalid `$` references, scoped names, version-qualified parents, repeated parents and cycles. Compatible shared incoming links must all be accounted for; exact-pin/shared conflicts fail before write. Conflicting existing target policies fail, unrelated overrides and existing `"."` values survive, cleanup restores original transitive manifest bytes, and new empty containers disappear.
- [ ] **Step 2 — Red:** Run `node --test test/scopes.test.js test/mutation.test.js test/installer.test.js`; expect missing behavior.
- [ ] **Step 3 — Implement scope decisions:** Enumerate relevant root-to-parent ancestry from validated public paths graphs without expanding cycles indefinitely. Try version-qualified parent scopes, then add ancestor qualifiers when the initial rule also affects other target locations. Use read-only public Arborist virtual graphs in scratch directories to compare effective edges for each tentative rule set against the original; do not approximate version selectors as installed-version equality. Accept only a combined scope whose affected target edges resolve to the selected location and whose direct-parent effective specs are preserved. If no expressible safe scope exists, return an applicability error; no global old-version fallback, forced split, or parent upgrade.
- [ ] **Step 4 — Implement edits/install:** Direct edits replace the version after the literal ^/~ in each applicable declaration; transitive edits merge selected scoped rules into the original object and retain exact cleanup bytes. Detect input formatting/newline style for minimal edits where practical. Installer invokes npm `install` with the context's required flags, captures bounded diagnostics/progress to stderr, and rejects nonzero exit. Use Task 3's ownership checks around writes and inspected npm-produced dependency-file updates. Do not hand-edit lockfile dependency resolutions.
- [ ] **Step 5 — Green/commit:** Run focused suites and `npm test`. Scope tests include scratch graph inspection without real target installs; real resolver proof follows in Tasks 9–11. Commit Task 6.

### Task 7: Verify exact target scope, cleanup, and supporting dependency changes

**Files:** Create `src/verify.js`, `test/verify.test.js`; extend graph helpers only within their public interfaces.

**Interfaces:** Produce `verifyGraph(before: Graph, after: Graph, evidence: Evidence, candidate: Candidate, mutation: Mutation, phase: 'installed'|'cleaned') -> { supportingChanges: SupportingChange[], changedVersions: Map<string,string[]> }`; `verifyFinalSecurity(evidence, candidate, graphDiff, context, adapters) -> Promise<void>`. Consume fresh `readCandidateAdvisories` and public uncached audit evidence from Tasks 4/5.

- [ ] **Step 1 — Failing tests:** Target must stay at the original location with selected version; original incoming consumers must still resolve correctly; every other installation of that package keeps its location/version. Detect relocation, scope widening, forced-pin branches, changed parent versions and unexplained unrelated churn. Allow S01 helper 2.x→3.x and supporting additions/removals/relocations within the before/after target closure. Test cycles, shared helper consumers, optional absence versus a missing required edge, lockfile v2 duplicate representations, and bookkeeping-only changes. Reject a shared helper upgrade that invalidates another consumer, a too-young/unverifiable newly resolved supporting version, and any newly vulnerable changed supporting package/version.
- [ ] **Step 2 — Red:** Run `node --test test/verify.test.js`; expect missing exports/behavior.
- [ ] **Step 3 — Implement:** Compute cycle-safe reachability before and after from the selected node; identify semantic changes by package/version/location and incoming edges rather than textual lockfile diff. Require all other target copies unchanged even inside that closure. Treat outside-closure changes as disallowed except equivalent metadata. For supporting relocations, pair unique equivalent identities deterministically; represent ambiguous moves as explicit additions/removals rather than inventing a pairing. Check expected manifest/root metadata, actual target installation, and parent specs through Task 4's graphs. At cleaned phase require temporary overrides gone and candidate version unchanged.
- [ ] **Step 4 — Implement fresh security gate:** Query the selected and changed supporting versions uncached and perform the fresh public audit. Retrieve catalog timestamps for newly resolved supporting versions and enforce the same effective age/cutoff policy; do not reject an unrelated unchanged locked version merely for being young. Ignore unrelated pre-existing findings for success classification, but reject a vulnerable selected version or newly introduced vulnerable supporting version. Advisory changes produce `STALE_RECOMMENDATION` for the selected recommendation; supporting vulnerabilities produce verification failure. Never choose another version or retry automatically.
- [ ] **Step 5 — Green/commit:** Run focused tests and `npm test`; commit Task 7.

### Task 8: Orchestrate one transaction, commit it, and render completed output

**Files:** Create `bin/npm-dep-upgrade.js`, `src/cli.js`, `src/report.js`, `test/cli.test.js`, `report.test.js`; extend `src/git.js`, `src/recovery.js`, and `test/git.test.js`.

**Interfaces:** Produce `commitUpgrade(guard, expectedFiles, identity: { package, oldVersion, newVersion }) -> Promise<{ hash, subject, changedFiles }>`; `renderMarkdown(result: UpgradeResult) -> string`; `renderJson(result: UpgradeResult) -> string`; `main(argv, io = process, deps = defaults) -> Promise<number>`.

- [ ] **Step 1 — Failing tests:** Assert stage ordering: parse → Git/project preflight → planner selection → fresh evidence/context/candidate → scope/edit → install/graph check → optional transitive cleanup/install/graph check → fresh security → commit → completed render. No install before eligibility/age checks, no success stdout before verified commit, no automatic retry, no commit on stale/failure, direct path one install, transitive path two. Verify exact commit subject, paths and hash; JSON fields match `UpgradeResult`; Markdown/control characters escape safely; errors remain on stderr and exit 1.
- [ ] **Step 2 — Red:** Run `node --test test/cli.test.js test/report.test.js test/git.test.js`; expect missing orchestration/commit assertions.
- [ ] **Step 3 — Implement transaction:** Wire only the prior tasks' contracts. Recheck ownership/HEAD/index at pre-write and pre-commit checkpoints. On pre-staging install/cleanup/verification errors, recover owned dependency files and report installed-tree uncertainty. Keep every stage's progress on stderr. `--help`/`--version` bypass project loading, while ordinary invalid selectors fail without mutation.
- [ ] **Step 4 — Implement commit state handling:** Stage only changed project dependency paths using `git add -- <paths>`, recheck the complete index, and run normal Git commit with an argv subject. Verify one resulting commit, exact subject and changed paths, and committed/working file bytes before emitting success. For a rejecting hook/commit failure preserve verified working changes and unstage only operation-owned paths when safe. If HEAD or files changed unexpectedly, inspect/report state without reset/amend/second commit. Add G06/G07 tests with real rejecting/modifying hooks in fixture repositories and deterministic checkpoint injections.
- [ ] **Step 5 — Green/commit:** Run focused suites and `npm test`; commit Task 8. This deliverable is functionally wired but still awaits real registry/installer E2E proof.

### Task 9: Build the isolated real registry, tarball, and Git E2E harness

**Files:** Create `test/e2e/helpers/registry.js`, `tarballs.js`, `project.js`, `commands.js`, `runner.js`, `test/e2e/fixtures/catalog.js`, `collisions.json`, and `test/e2e/harness.test.js`.

**Interfaces:** Produce `startRegistry(scenario) -> Promise<{ url, calls, setPhase(phase), close() }>`; `createProject(scenario, runtime) -> Promise<{ root, initialHead, initialFiles, cleanup() }>`; `createCommandPath(runtime, toolRoots) -> Promise<{ env, npmVersion }>`; `runUpgrade(fixture, args) -> Promise<{ code, stdout, stderr }>`; `assertResolved(fixture, parentLocation, packageName, expectedVersion) -> Promise<void>`. `runtime` points to an explicitly provisioned npm CLI, never an implicitly downloaded global replacement.

- [ ] **Step 1 — Failing harness tests:** Assert a fixture install fetches only local metadata and tarballs with valid integrity, and real npm audit receives version-dependent advisory responses. Test explicit phase changes, gzip request decoding where npm sends it, expected security endpoints, fresh caches/config, blocked unknown/public requests and all scratch paths below the approved tmp root. Seed old target 6.0.9 against a reduced catalog before exposing safe releases. Assert fixture Git setup commits its baseline with local identity, without using developer hooks/config.
- [ ] **Step 2 — Red:** Run `node --test --test-name-pattern=harness test/e2e/harness.test.js`; expect missing harness functions or local service behavior. No product expectation is allowed to pass by stubbing npm install.
- [ ] **Step 3 — Implement harness:** Make minimal valid npm tarballs with `package.json` and `index.js`; use deterministic archive data and computed integrity, with all artifacts under tmp. Create private per-case npm config/cache/audit-cache and local-only registry/audit/scoped settings. Command launchers run the actual four local tool entry points and the selected npm, including Windows `.cmd` shims. Services fail unknown requests; audit output is computed by real npm from controlled bulk responses, not a hardcoded post-install clean result. Implement explicit request/stage checkpoints instead of sleeps. For cleanup-result/command-boundary faults, use fixture-only launchers that forward to real npm/Git and inject the prescribed failure or file change at a counted boundary; never report a fake successful install instead of running npm. Do not add production fault-injection CLI flags. Freeze actual collision fixtures after computing and verifying the prescribed hashes offline; never replace the product hash function in collision E2E tests.
- [ ] **Step 4 — Green real smoke:** Run D01 dependencies/caret through the real new tool, real planner/audit/paths, npm 12.1.0 and Git. Assert selected 6.0.12, updated ^6.0.12, one correct commit, no lifecycle sentinel, and clean reproduction with `npm ci --ignore-scripts`. Run focused harness tests until these pass.
- [ ] **Step 5 — Commit:** Commit harness and real success smoke using Task 9 subject; no version bump.

### Task 10: Cover successful direct/transitive scopes, IDs, and supporting changes

**Files:** Create `test/e2e/direct.test.js`, `transitive.test.js`, `ids.test.js`, `supporting.test.js`; add concrete scenario data under `test/e2e/fixtures/` and reusable assertions to the harness.

**Interfaces:** Consume Task 9's fixture/runner/assertion functions and the catalog's complete manifests. Each test passes a real current planner ID into one CLI invocation; no saved-plan file or multiple-ID execution helper.

- [ ] **Step 1 — Failing cases:** Implement D01's eight section/operator variants, D02, compatible D04; T01's four root sections and child ^/~ variants; T02/T03/T05/T07 eligible side; O01; R01/R03 valid fallback/R04 A/C/R06; H01–H04 real prefix-selection cases; S01/S02 success boundaries; G02/G03; F06 clean reproduction. Assert the original T04 graph before selecting its eligible side and accept only a safely expressible scope or the specified applicability refusal. Verify every case's target via parent-relative resolution, not a top-level version shortcut.
- [ ] **Step 2 — Red:** Run `node --test test/e2e/direct.test.js test/e2e/transitive.test.js test/e2e/ids.test.js test/e2e/supporting.test.js`; confirm each newly added assertion initially exposes missing product/harness coverage or behavior before correcting it. If existing code already satisfies a case, record that observed result rather than introducing a regression just to force red.
- [ ] **Step 3 — Complete fixtures/minimal fixes:** Materialize all manifests as isolated registry packages, never workspaces/file dependencies. Assert initial topology for shared versus separate copies. Fix only the owning product module when a case fails; add the focused regression test there. Supporting helper 2.0.5→3.0.2 is allowed; the other target copy, parent versions, and unrelated direct package remain unchanged. Inspect committed file contents and reproduce from the final committed pair.
- [ ] **Step 4 — Green/commit:** Run these E2E files on npm 12.1.0 and `npm test` in the new tool; commit Task 10. Use stable case IDs in test names for reviewability.

### Task 11: Cover ineligible inputs, stale advisories, recovery, and compatibility

**Files:** Create `test/e2e/ineligible.test.js`, `security.test.js`, `git.test.js`, `recovery.test.js`, `compatibility.test.js`; extend helper checkpoints and scenario data as needed.

**Interfaces:** Reuse the harness. Add `runCase(caseId, { npmCli, lockfileVersion: 2|3, installed: boolean })` in `test/e2e/helpers/runner.js` as a scenario dispatcher, not a product orchestrator.

- [ ] **Step 1 — Failing cases:** Cover D03/exact D04, T06/T08 and T07's retained pinned copy; O02–O04; R02/R03 no fallback/R04 B/R05; F01–F05 as amended; H05, G01/G04–G07, and S03. Assert no commit/success stdout after failures; dirty input refusal must preserve the original files/index before any install. Candidate-only advisories must be caught before mutation; advisory drift at the explicit post-selection checkpoint must produce stale error and no silent 6.0.13 retry. Post-verification commit-hook failure instead retains verified working changes and reports that state.
- [ ] **Step 2 — Red:** Run the new E2E files individually and record the specific missing behavior. Use explicit server/checkpoint failures, not network timing races. A malformed audit response cannot count as zero vulnerabilities.
- [ ] **Step 3 — Complete negative behavior:** Correct only targeted product/harness defects, adding unit regressions to the owning modules. Preserve unrelated unstaged/untracked files, never reset HEAD, and check any hook-created/unexpected commit state rather than issuing a second commit. Repeat a resolved ID and require target-not-found/no second commit.
- [ ] **Step 4 — Matrix verification:** Provision npm CLIs 12.1.0 and 11.10.0 under the approved tmp tooling directory, with versions checked before use and their isolated launchers prepended to PATH. Run the design/catalog's 11.10.0 subset; lockfile v2 variants D01/T01/T05/F06; no-initial-node_modules variants D01/T01/T07. npm's own fixture setup is outside the isolated E2E network phase; the actual cases never access public registries. Do not silently skip a requested runtime because setup failed.
- [ ] **Step 5 — Green/commit:** Run the full npm 12.1.0 E2E suite, the named compatibility matrix, and new-tool unit tests. Commit Task 11 when all applicable cases pass; report any environment-blocked platform checks accurately rather than marking them complete.

### Task 12: Document the mutator, wire CI, and run required checks

**Files:** Create `tools/npm-dep-upgrade/README.md` and `.github/workflows/npm-dep-upgrade.yml`; modify root `AGENTS.md` and `README.md`, planner README, and any focused test documentation needed to expose actual commands.

**Interfaces:** Documentation matches the approved CLI and output contracts. E2E runtime selection uses test-only `NPM_DEP_UPGRADE_E2E_NPM_CLI` (absolute npm CLI JS entry) and `NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI` (11.10.0 entry). Scratch roots honor `NPM_DEP_FLOW_TEST_TMPDIR`, `NPM_DEP_PATHS_TEST_TMPDIR`, and `TMPDIR`; production CLI does not gain these as user-facing flags.

- [ ] **Step 1 — Write docs/CI checks:** Document install prerequisites, npm/Node reference versions, hash/full-prefix ambiguity, one-ID execution, ^/~ and exact-pin scope, supporting changes, override cleanup, no scripts, Git refusal/commit/recovery behavior, and scoped/nested project examples. Narrow AGENTS' blanket read-only statement to analysis tools and explicitly document the mutator's authorized writes/install/commit behavior. Add one tool-index row and retain existing tool contracts.
- [ ] **Step 2 — CI matrix:** Follow existing workflow conventions and pinned action revisions. Use Node.js 24.21.0; install dependencies for all four tools with scripts disabled. Provision both pinned npm CLIs locally for Linux, and provision 12.1.0 for Windows. Run full default Linux suite and the explicit 11.10.0 subset; run real Windows smoke D01/T01/O03/F06 plus parser/process/Git unit tests. Do not use globally installed development copies to stand in for the checkout's CLIs or leak test registry configuration into provisioning.
- [ ] **Step 3 — Required verification:** From each independent tool directory run `npm ci --ignore-scripts` and `npm test`. Run audit/paths integration with `NPM_DEP_PATHS_INTEGRATION=1`, planner/audit integration with `NPM_DEP_AUDIT_INTEGRATION=1`, and the new default/compatibility E2E commands with isolated launcher paths and scratch variables. Run `git diff --check`. Existing tools' tests must remain green; only the new mutator is allowed to mutate target fixtures.
- [ ] **Step 4 — Coverage audit:** Map all 43 named catalog cases and their variants to test names, including amended F03–F05 and H/G/S additions. Confirm real full-stack cases were not replaced with fake npm output. Inspect command logs, scripts sentinels, commit contents, and preserved outside files. Record Windows results from CI if the local host cannot run them.
- [ ] **Step 5 — Commit:** Commit the docs/workflow deliverable with Task 12 subject after the applicable checks pass. No tool versions change in this commit.

### Task 13: Set release metadata once, after implementation verification

**Files:** Modify planner `package.json`/`package-lock.json` and new mutator `package.json`/`package-lock.json` only.

**Interfaces:** Planner publishes version 0.3.0 for additive ID capability; new mutator's initial release version is 0.1.0. Bin help/version read actual package metadata rather than hardcoded version constants.

- [ ] **Step 1 — Confirm prior checks:** Review recorded required unit/integration/E2E/CI results and the case-coverage mapping. Resolve outstanding implementation failures before release metadata. Confirm no earlier implementation commit bumped an existing tool and no unrelated tool changed version.
- [ ] **Step 2 — Set versions:** Change planner 0.2.2→0.3.0 and mutator 0.0.0→0.1.0 together; update the top-level and root package entries in each lockfile. Do not run a tag-producing version command or increment an already intended release version for follow-up fixes.
- [ ] **Step 3 — Verify metadata:** Run the two real executables with `--version` and `--help`; assert package versions, lockfile root versions, installed-directory output, and bin mappings agree. Run focused help/version tests and `git diff --check`. Broaden testing only if the metadata change exposes a new concern.
- [ ] **Step 4 — Commit:** Commit all four metadata files together using `chore: set dependency upgrade release versions`. Inspect final status/history and summarize verified behavior and material limitations. Do not merge, push, or create a PR unless authorized in the execution conversation.

## Coverage map for self-review and execution

| Specification/cases | Owning implementation and verification |
| --- | --- |
| Planner ID field/Markdown column; H01 | Task 1; Task 4 consumer validation; Task 10 real planner coverage. |
| CLI/hash matching and diagnostics; H02–H05 | Tasks 2/4/8; real collisions in Task 10 and negative cases in Task 11. |
| Git preflight/snapshot/recovery; amended F03 and G01/G04/G06/G07 | Tasks 3/8; Task 11 real Git/fault cases. |
| Fresh project/requirements and scoped parents; T01–T08 | Tasks 4/6/7; T01–T05/T07 success or applicability coverage in Task 10, T06/T08 and failures in Task 11. |
| Direct requirement operators/sections; D01–D04 | Tasks 4/6; Task 10 compatible variants and Task 11 exact-pin refusal. |
| Existing override preservation/cleanup; O01–O04 | Tasks 6/7/8; Task 10 preservation success and Task 11 conflicts/cleanup failures. |
| Newest candidate, release age, timestamps, scoped registries; R01–R04/R06 | Task 5; Tasks 10/11 fixture snapshot variants. |
| Advisory drift and candidate-only advisories; R05/F01/G05 | Tasks 5/7/8; Task 11 controlled phase transitions. |
| Supporting dependency changes; S01–S03 | Task 7; Task 10 allowed helper changes and isolation, Task 11 vulnerable-helper rejection. |
| Operational failures, no findings, repeat run; F01–F05 | Tasks 3–8; Task 11 failure, ineligible, target-not-found and recovery tests. |
| Real tarballs/scripts suppression/reproduction; F06 | Tasks 9/10; Task 11 runtime/lockfile/installation-state matrix. |
| Commit subject/paths and unrelated unstaged work; G02/G03 | Tasks 3/8; Task 10 real commit assertions. |
| Output, portability, docs and runtime provisioning | Tasks 2/8/9/12; Linux full suite and Windows real smoke in Task 12. |
| Package version and lockfile metadata sequencing | Task 13 only; no earlier release-version changes. |

## Plan review and execution handoff

This plan implements the approved design; it does not authorize implementation before the written plan is reviewed. No execution method has yet been selected.

Recommended execution method: **Native**. The tasks share the same evidence, mutation, graph, and recovery contracts, so one implementer can maintain those invariants without repeatedly transferring the full context. Complete one fresh independent whole-branch review at the end. **Subagent-driven** is also available if the user prefers per-task implementer/reviewer gates and the additional context cost.

After plan approval and method selection, use the corresponding execution skill, run the required baseline checks, and implement task-by-task. Preserve the user's worktree/tmp paths and package-version sequencing. If review identifies a necessary change to the approved behavior rather than an implementation choice, update the specification for review before implementing that behavior.
