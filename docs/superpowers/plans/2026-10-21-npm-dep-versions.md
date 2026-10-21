# npm-dep-versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a cached, filterable package release catalog from one combined npm command and consume it through the planner's public CLI boundary.

**Architecture:** A standalone CLI normalizes `versions` and `time`, caches the complete catalog, then filters and renders it. The planner validates the new CLI's schema version 2 report and retains the earliest upstream freshness in its result cache. The mutator retains its independent fresh registry and security checks.

**Tech Stack:** Node.js 20+ ESM, semver, node:test, existing standalone CLI/debug/cache conventions; Node.js 24 for development and CI.

**Spec:** [Approved design](../specs/2026-10-21-npm-dep-versions-design.md).

## Global Constraints

- Root remains a non-package; tools never import sibling private source.
- Run exactly `npm view <package> versions time --json` on a catalog miss or bypass; never fall back to separate field commands.
- Preserve planner schema version 2, strategy behavior, nullable dates, and analysis read-only behavior.
- Cache lifetime defaults to `1h`; `--no-cache` bypasses both reads and writes and propagates through nested calls.
- New tool release is `0.1.0`; planner release is `0.6.0`, bumped once from `0.5.0` in the final release commit with matching lockfile metadata.
- New package may use `0.0.0` as its private development version until the final release metadata commit. Never bump an existing tool early.
- Preserve Unix argument-array launching and safe Windows `.cmd` launching, stderr debug redaction, and no partial stdout on errors.
- All temporary files, dependency-download caches, test roots, and test caches go under `/home/maw/src/nrc/npm-dep-flow-impl/tmp` during local execution. New worktrees go under `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`.
- Follow AGENTS.md and CONTRIBUTING.md; no recommended lint rule overrides. Inspect changed help for common-column alignment.

## Review Focus

- Packages with no usable `latest` metadata can cause npm to emit no JSON: fail clearly without guessing an empty catalog (Task 1).
- Concurrent catalog writers must leave a complete valid cache entry and no shared temporary filename (Task 3).
- Symlinked configuration directories should share canonical context identity and retain the correct npm cwd (Task 3).
- A registry refresh exceeding the requested TTL must not be accepted by the planner as fresh evidence (Task 4).
- Registry-only inspection must work in a directory without either dependency file and leave it unchanged (Task 2/3).

## File map and interfaces

All paths below are relative to the execution checkout, not the parent directory. Use absolute paths in user-facing links.

| Location | Responsibility |
| --- | --- |
| `tools/npm-dep-versions/package.json`, `package-lock.json`, `bin/npm-dep-versions.js` | Independent private package, semver dependency, executable, Node >=20, node:test script |
| `tools/npm-dep-versions/src/registry.js`, `model.js` | Combined query and pure normalization, canonical semver and UTC timestamp validation |
| `tools/npm-dep-versions/src/args.js`, `filter.js`, `report.js`, `cli.js` | Validated options, catalog filtering, Markdown/JSON, complete-report orchestration |
| `tools/npm-dep-versions/src/process.js`, `debug.js` | Tool-owned portable subprocess and established debug behavior |
| `tools/npm-dep-versions/src/context.js`, `cache.js` | Canonical directory/npm identity, catalog validation and atomic caching |
| `tools/npm-dep-versions/test/*.test.js`, `test/helpers/registry.js`, `test/helpers/commands.js` | Behavioral, executable, fixture-registry, and npm runtime compatibility checks |
| `tools/npm-dep-upgrade-plan/src/versions.js` | New public CLI adapter; replaces `src/registry.js` |
| `tools/npm-dep-upgrade-plan/src/cli.js`, `context.js` | Catalog calls, sibling identity, earliest-source cache freshness |
| Planner `test/versions.test.js`, `cli.test.js`, `context.test.js`, `result-cache.test.js`, `debug.test.js`, `audit.integration.test.js` | New command boundary and freshness coverage; retire registry adapter tests |
| Upgrade `test/e2e/helpers/commands.js`, `provision.js`, affected executable/debug fixtures | Install/exercise new required planner dependency without changing mutation logic |
| `.github/workflows/npm-dep-versions.yml`, `npm-dep-upgrade-plan.yml`, `npm-dep-upgrade.yml`; `dev-tooling/eslint.config.mjs` | New CLI CI, dependent installation, lint coverage |
| Root/tool READMEs, `AGENTS.md`, `CONTRIBUTING.md` | Usage, installation order, boundaries, cache and verification documentation |

Common shapes (plain objects, not classes):

```text
Row = { version: string, releasedAt: string | null }
Catalog = { schemaVersion: 2, package: string, fetchedAt: string, rows: Row[] }
Options = { packageName, projectPath, all, major: number|null, range: string|null,
            format: 'markdown'|'json', ttlMs, noCache, debug, help, version }
Context = { root: string, npmVersion: string, configHash: string }
Run(command, args, cwd) -> Promise<{ code, stdout, stderr }>
```

`Catalog` caches every strict valid semantic version, including prereleases. A rendered report has the same shape with filtered rows. Use injected `run`, `now`, and `cacheRoot` seams for meaningful boundary/freshness tests; do not invent another shared library.

## Intended implementation commits

1. `feat(versions): normalize combined npm release catalogs` — Task 1, package and compatibility fixtures.
2. `feat(versions): expose stable and semantic version filters` — Task 2, executable and reports.
3. `feat(versions): cache complete catalogs by npm context` — Task 3, cache/context and CLI wiring.
4. `feat(upgrade-plan): consume cached version catalogs` — Task 4, adapter/freshness and regression fixtures.
5. `test(versions): integrate catalog CLI across toolchain` — Task 5, real boundaries, CI/lint coverage and docs.
6. `chore: release versions 0.1.0 and upgrade-plan 0.6.0` — Task 6, final release metadata only.

Commit this plan before execution. If a purely mechanical formatting change is necessary, commit it separately from behavioral work. Include required tests in each behavioral commit. Keep the working tree committed before requesting independent review.

## Execution preparation

- [ ] Read the approved spec, AGENTS.md, and CONTRIBUTING.md. Use using-git-worktrees to establish an execution worktree under the required parent, based on the branch containing this spec and plan; preserve this documentation checkout.
- [ ] Create a task-specific scratch directory beneath the required tmp root. Set `TMPDIR`, `TMP`, `TEMP`, `NPM_DEP_FLOW_TEST_TMPDIR`, `NPM_DEP_PATHS_TEST_TMPDIR`, `XDG_CACHE_HOME`, and `npm_config_cache` to appropriate subdirectories there. Do not put credentials in logs or committed fixtures.
- [ ] Confirm Node 24 and inspect existing pinned npm runtimes before downloading anything. Record absolute entries for npm 12.1.0 and npm 11.10.0 using the E2E variables documented in the upgrade README. Provision only missing runtimes outside test cases.
- [ ] Run affected baseline suites (`npm test` in planner and upgrade) and shared lint after their `npm ci --ignore-scripts` installs. Record existing failures before coding; use the normal debugging workflow for unexpected failures.

### Task 1: Normalize one combined registry query

**Files:** Create new package manifests, `src/model.js`, `registry.js`, `process.js`, `debug.js`; tests `model.test.js`, `registry.test.js`, `process.test.js`, `debug.test.js`, `registry.integration.test.js` and `test/helpers/{registry,commands}.js`. Modify shared lint config to cover the new tool from its first code commit.

**Interfaces:** Produce `isCanonicalVersion(value) -> boolean`, `normalizeTimestamp(value) -> string|null`, `normalizeCatalogResponse(raw) -> Row[]` in model.js; `fetchCatalog(root, packageName, { run = runProcess, now = Date.now } = {}) -> Promise<Catalog>` in registry.js. Process exposes the `Run` signature above. Debug exposes tool-owned `runDebug`, `debugSpawn`, `debugLog` using existing conventions with the new tool label.

- [ ] Write failing model/registry tests with these representative assertions:

```js
assert.deepEqual(normalizeCatalogResponse({
  versions: ['1.0.0', '1.1.0-beta.1', '1.0.0', 'v2.0.0'],
  time: { '1.0.0': '2026-10-01T12:00:00Z', '9.0.0': '2026-01-01T00:00:00Z' },
}), [
  { version: '1.0.0', releasedAt: '2026-10-01T12:00:00.000Z' },
  { version: '1.1.0-beta.1', releasedAt: null },
])
assert.equal(normalizeTimestamp('2026-02-30T00:00:00Z'), null)
assert.equal(normalizeTimestamp('2026-10-01T12:00:00+25:00'), null)
assert.deepEqual(calls[0], ['npm', ['view', '@scope/pkg', 'versions', 'time', '--json'], root])
```

Also assert singleton combined envelopes, scalar/list versions-only output, absent/null time, empty versions, equal-precedence build ordering, invalid fields, no JSON output, missing npm and nonzero exits without secret output. No second command may appear on parse failure.
- [ ] Run `node --test test/model.test.js test/registry.test.js` in the new package; expect failing imports or assertions before implementation.
- [ ] Create the independent package with semver using the repository's existing compatible dependency version and lockfile. Implement the exact signatures above. Copy/adapt process and debug code into this tool's ownership, without runtime sibling imports; validate package names before either platform launches a shell command.
- [ ] Write process/debug tests for Unix arguments, Windows `.cmd` execution, safe scoped names, rejected metacharacters, command timings, redacted URLs/tokens, and stderr-only debug relay. Run their failing cycle before implementing any adaptations.
- [ ] Build a minimal local HTTP fixture packument with stable and prerelease manifests, dist-tags, versions and optional time. Launch actual pinned npm 11.10.0 and 12.1.0 through test shims, run the exact combined command, and assert identical normalized results, including omitted time and no usable latest response. These helpers belong to the new tool; do not import upgrade private helpers. Supply runtime entry paths with the existing `NPM_DEP_UPGRADE_E2E_NPM_CLI` and compatibility variable so CI can reuse provisioned runtimes.
- [ ] Extend shared lint's explicit tool glob with npm-dep-versions, without changing recommended rules. Run new package `npm test`; both configured runtime compatibility cases must pass. Run `npm --prefix dev-tooling run lint` from the checkout root and inspect staged diff, then commit Task 1 without changing planner versions. Run shared lint again before each subsequent JavaScript commit.

### Task 2: Deliver filtered reports through the executable

**Files:** Create `src/args.js`, `filter.js`, `report.js`, `cli.js`, executable, initial README; tests `args.test.js`, `filter.test.js`, `report.test.js`, `cli.test.js`.

**Interfaces:** Consume Catalog and fetchCatalog. Produce `parseArgs(argv, cwd = process.cwd()) -> Options`, `filterRows(rows, { all, major, range }) -> Row[]`, `renderJson(report) -> string`, `renderMarkdown(report) -> string`, `main(argv, io = process, deps = defaults) -> Promise<number>`. CLI resolves real project directory and stats it before fetching; cache/context integration follows Task 3. Help/version return before package or directory validation.

- [ ] Write failing argument tests covering every specified flag, default cwd, canonical package names, duplicate value options, absent/unknown values, extra packages, idempotent switches, safe integer major zero, rejected `01`/negative/unsafe major, whitespace-only/invalid ranges, valid TTL units and overflow, invalid format, and help/version without package.
- [ ] Write filtering/report assertions:

```js
assert.deepEqual(filterRows(rows, { all: false, major: 19, range: null }).map(r => r.version), ['19.0.0', '19.1.0'])
assert.deepEqual(filterRows(rows, { all: true, major: 19, range: '>=19 <20' }).map(r => r.version), ['19.0.0', '19.1.0-beta.1', '19.1.0'])
assert.equal(JSON.parse(renderJson(report)).schemaVersion, 2)
assert.match(renderMarkdown({ ...report, rows: [] }), /No matching versions/)
assert.doesNotMatch(renderMarkdown({ ...report, rows: [] }), /\| Version/)
```

Define rows containing 18.x, 19.0.0-beta.1, 19.0.0, 19.1.0-beta.1, 19.1.0, and 20.0.0; verify major/range intersection, build ties, unchanged original strings, nullable dates, UTC display, escaping and control characters.
- [ ] Run the new focused tests; expect failures before implementing their modules.
- [ ] Implement these functions and aligned help text. Use includePrerelease only with --all, preserving actual semver bounds. Main writes one completed report or a sanitized error and no stdout. The executable forwards the returned exit code.
- [ ] Add failing executable cases for an empty context directory, explicit --project with spaces, a missing/file context, help/version without npm on PATH, unchanged directory contents, registry error with secret stderr, and debug on/off. Implement minimal orchestration to pass them.
- [ ] Run `npm test` in the new package and `node bin/npm-dep-versions.js --help`; inspect alignment and full option coverage, then commit Task 2.

### Task 3: Cache complete catalogs under effective npm context

**Files:** Create `src/context.js`, `cache.js`, `test/context.test.js`, `cache.test.js`; modify new CLI and executable tests/README.

**Interfaces:** Produce `readContext(root, run = runProcess) -> Promise<Context>` and `cachedCatalog({ version, root, packageName, identity, ttlMs = 3600000, noCache = false, cacheRoot, now = Date.now }, compute) -> Promise<Catalog>`. CLI canonicalizes root; with caching enabled, identity is readContext's npmVersion/configHash; bypass omits cache-only context discovery. `compute` invokes fetchCatalog and returns its full Catalog. Default cacheRoot uses XDG/home conventions in the spec.

- [ ] Write failing context tests: sorted config digest, scoped registry/auth change invalidation without persisted secrets, npm version changes, ignored moving `before`, malformed or failed commands, canonical symlink identity. Skip only symlink creation when the OS explicitly denies that capability.
- [ ] Write failing cache tests using injected clock and a local scratch root. Assert a fetch at `1000` is hit at `1099` with TTL `100`, missed at `1100`, and missed at `1050` with TTL `50`; hits preserve fetchedAt. Assert distinct package/context/npm/config/tool identities, corrupt/checksum-invalid/future timestamps, malformed rows, and unavailable storage are misses. Assert failed refresh never returns stale data and bypass preserves existing bytes.
- [ ] Run `node --test test/context.test.js test/cache.test.js`; expect failures before implementation.
- [ ] Implement digest identity, full catalog validation, private modes, unique temporary files and atomic rename/cleanup. Key the cache file by canonical root/package; validate the full identity inside the entry. Apply current TTL to original fetchedAt and do not extend it during writes or hits. Reuse validation from this tool's model only.
- [ ] Add failing CLI tests that invoke stable/--all/major/range/JSON/Markdown against one cache and count exactly one combined view command. Concurrent invocations must leave a parseable valid entry and no temporary files. Context changes must miss; bypass must not call config solely for cache identity. Check an empty directory still requires no manifest/lockfile and remains untouched.
- [ ] Wire caching before filtering, run new package `npm test`, inspect persisted fixtures for absence of config secrets, and commit Task 3.

### Task 4: Integrate planner command boundary and source freshness

**Files:** Create planner `src/versions.js`, `test/versions.test.js`; replace old registry imports/tests; modify `src/cli.js`, `context.js`, corresponding CLI/context/cache/debug and executable fixtures.

**Interfaces:** Produce `runNpmDepVersions(projectRoot, packageName, spawnImpl = spawn, platform = process.platform, { noCache = false, ttlMs = 3600000, now = Date.now } = {}) -> Promise<{ versions: string[], releaseTimes: Map, fetchedAt: string }>`. Use existing planner runProcess/debug boundary. Planning context adds `versions` containing the new sibling's --version output with installed location.

- [ ] Write failing adapter tests for default/explicit TTL, no-cache, debug propagation, scoped package/cwd, Windows shim, missing sibling guidance, nonzero exit and malformed JSON. Validate exact package/schema, rows and uniqueness, canonical stable versions, canonical nullable UTC timestamps, future dates and age equal to TTL. Sort valid rows before constructing versions/releaseTimes. Reject evidence that expired while a slow subprocess ran by consulting `now` after completion.
- [ ] Run `node --test test/versions.test.js` in planner; expect failure before implementation.
- [ ] Implement the adapter. Do not pass --all, --major, --range, or --project; cwd supplies context. Do not include child stdout or secret-bearing diagnostics in errors.
- [ ] Write failing planner CLI/context tests: one catalog invocation per distinct audited package; no direct npm view; known and null dates produce existing findings/schema unchanged; new sibling version/location changes invalidate cached reports; unsupported sibling output fails closed. Update injection fixtures to the new adapter interface rather than retain legacy fallback paths.
- [ ] Write a freshness regression using audit time T and catalog time T-30 minutes: a planner result at T must miss at T+30 minutes with TTL 1h. A shorter requested TTL is measured from the earliest source. No-package reports use audit time only. Keep auditedAt equal to T in output and nested bypass/TTL propagation unchanged.
- [ ] Run focused CLI/context/result-cache tests and confirm regression failures. Replace orchestration with the new adapter, compute freshAt as the minimum source timestamp, and set expiresAt no later than freshAt + ttlMs and existing upstream expiry. Remove obsolete registry module/tests. Existing result-cache machinery already supports freshAt; modify it only if a new test demonstrates a gap.
- [ ] Update affected executable/debug mock command dispatch to return versioned catalog JSON and correct sibling versions. Run planner `npm test` and new tool `npm test`; commit Task 4 with planner package version still 0.5.0.

### Task 5: Exercise real command chains and document installation

**Files:** New versions workflow; planner and upgrade workflows; shared lint config; planner `audit.integration.test.js`; upgrade helper `commands.js`, `provision.js`, affected fixtures/debug tests; root/new tool/planner/upgrade READMEs, AGENTS.md, CONTRIBUTING.md.

**Interfaces:** Preserve integration switches `NPM_DEP_AUDIT_INTEGRATION=1`, `NPM_DEP_PATHS_INTEGRATION=1`, and pinned E2E runtime entry variables. Provision the new CLI on PATH with sibling tools. Never import its private source from another tool.

- [ ] Change planner integration assertions to require exactly `view brace-expansion versions time --json` once on cold run, zero additional view calls on warm result hit, and one additional combined call after bypass. Use real audit and versions CLIs, existing fake paths/npm, and merged npm response fixtures. Run and observe failure before updating fixture command dispatch and PATH shims.
- [ ] Add an E2E boundary assertion that planner metadata flows through the new CLI and upgrade retains its fresh direct checks. Update provision/commands helper tool lists and relevant hardcoded command expectations; preserve existing failure/security assertions.
- [ ] Confirm shared lint includes the new tool. Add Ubuntu/Windows new-tool CI with Node 24 and both npm runtime compatibility cases on Linux, npm12 on Windows. Provision pinned runtimes outside cases; make compatibility CI require them rather than silently skip. Add versions installation to planner CI and the five-tool install/test/provision chain in upgrade CI. Retain pinned action refs and minimal permissions.
- [ ] Update documentation with install order (paths, audit, versions, planner, upgrade), --project's npm context role, every flag, no grep examples, merged nullable timestamps, schema v2 example, catalog reuse/freshness, nested TTL/bypass/debug, and independent fresh mutator evidence. Update repository guidance and root inventory from three to four analysis tools where appropriate.
- [ ] Run `npm test` in versions, planner, and upgrade; run audit/paths documented integration suites when exercising the complete chain. Run planner with `NPM_DEP_AUDIT_INTEGRATION=1 npm test` using the real new CLI on PATH, and upgrade `npm run test:e2e` with both pinned runtimes. Run `npm --prefix dev-tooling run lint` from the checkout root; expect exit 0 with zero warnings. Inspect new-tool/planner --help rendering and `git diff --check`. Resolve only failures related to this change; do not broaden production scope.
- [ ] Commit Task 5 with passing evidence recorded in the execution report. All runtime behavior and integration are now implemented; release metadata follows.

### Task 6: Finalize release metadata and review

**Files:** New-tool and planner package manifests and lockfile root metadata only, plus any documented version references that must match.

**Interfaces:** New tool reports npm-dep-versions v0.1.0; planner reports npm-dep-upgrade-plan v0.6.0; upgrade debug correction reports v0.3.1. Existing planner schema version 2 remains unchanged.

- [ ] Change new package development version to `0.1.0` and planner `0.5.0` to `0.6.0`, synchronizing each lockfile's top-level and root-package version. Execution refinement: bump upgrade from 0.3.0 to 0.3.1, with matching lockfile metadata, for the required nested catalog debug-prefix relay; no mutation logic changes.
- [ ] Run both --version commands and assert exact versions plus installed directories. Run both --help commands and inspect alignment with final version headers. Run affected tool tests and shared lint following metadata changes; repeat only the integration checks whose outputs include changed tool versions or remain unresolved.
- [ ] Run `git diff --check`, inspect staged release changes, and commit the intended final release message. Confirm git status is clean before requesting review.
- [ ] Apply requesting-code-review after execution using the user's selected method, address substantive findings, and rerun affected verification. If the user has not authorized a PR/merge, report branch, commits and evidence without publishing or merging. Use finishing-a-development-branch for integration choices within existing authorization.

## Plan self-review

Coverage: Task 1 owns combined-query shapes/timestamp merge; Task 2 owns filters and public output; Task 3 owns effective context and catalog freshness; Task 4 owns planner compatibility/source lifetime; Task 5 owns real process boundaries, CI and documentation; Task 6 owns final versions. Each Review Focus condition has an explicit owning test. Interface names and Catalog fields are consistent across tasks; compute returns the full unfiltered catalog, and only CLI rendering receives filtered rows. No product implementation is authorized by this planning document until the user reviews it and selects execution method.
