# `--clear-cache` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--clear-cache` flag to all five tools that deletes each tool's cache directory (and, through chaining, its sibling tools' caches) before running normally.

**Architecture:** Each tool gets its own small `src/cache-clear.js` helper (no sibling imports) and parses `--clear-cache` next to `--no-cache`. A tool clears its own directory first, inside its existing error handling, then forwards `--clear-cache` as an explicit argument on every child CLI call. `npm-dep-upgrade` owns no cache and only forwards to the planner. `--no-cache` is untouched.

**Tech Stack:** Node.js ESM, `node:test`, `node:fs/promises` `rm`; existing CLI/adapters in each `tools/<name>/`.

**Spec:** [2026-10-26-clear-cache-design.md](../specs/2026-10-26-clear-cache-design.md)

## Global Constraints

- Worktree: `/home/maw/src/nrc/npm-dep-flow-impl/worktrees/clear-cache`, branch `feat/clear-cache`. Scratch files go under `/home/maw/src/nrc/npm-dep-flow-impl/tmp`, never in the repo.
- Cache directory per tool is exactly `join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), '<tool-name>')` as each tool already resolves it; tests inject a `cacheRoot`.
- Chain: planner → audit and versions (every call); audit → paths (every call); upgrade → planner. Explicit `--clear-cache` argument, not an environment variable.
- A missing cache directory is success. Any other deletion error: exit 1, stderr `<tool>: <message>`, empty stdout, before any cache read or child spawn.
- `--clear-cache` is ignored by `--help` and `--version` (no deletion). Combined with `--no-cache`: clear, then run without reading or writing cache.
- No report/schema changes. `--no-cache` behavior unchanged. Debug logs `cache clear` via the tool's existing `debugLog`.
- Never import a sibling tool's private source. Subprocess launching stays portable (`.cmd` through a shell on Windows) by editing only the argument arrays in existing adapters.
- Lint with zero warnings; no rule-disable comments, no Prettier. Each tool's `--help` stays column-aligned.
- Commit headers are Conventional Commits. Version bumps happen only in the final commit: paths 0.6.0→0.7.0, versions 0.1.0→0.2.0, audit 0.4.0→0.5.0, planner 0.7.0→0.8.0, upgrade 0.4.0→0.5.0, each in `package.json` and `package-lock.json` (top-level `version` and `packages[""].version`).
- Install per tool before testing: `npm --prefix tools/<name> ci --ignore-scripts`, and `npm --prefix dev-tooling ci --ignore-scripts` for lint. Create scratch dirs before pointing `TMPDIR`/`NPM_DEP_*_TMPDIR` at them.

## Review Focus

1. Cache directory absent → `--clear-cache` succeeds and the run proceeds (Task 1 helper and CLI tests; repeated in each tool's CLI test).
2. Cache path cannot be removed → exit 1, stderr message, empty stdout, no child spawned and no computation (every tool's CLI test).
3. `--clear-cache --no-cache` together → cache cleared, run executes, nothing written (Tasks 1–4).
4. `--clear-cache --help` / `--version` → prints help/version, deletes nothing (Tasks 1–5).
5. A child tool fails while clearing → parent exits 1 with the child's error and no stale or partial report (Tasks 3, 4, 5, 6).

---

## Task 1: `npm-dep-paths --clear-cache`

**Files:**
- Create: `tools/npm-dep-paths/src/cache-clear.js`, `tools/npm-dep-paths/test/cache-clear.test.js`
- Modify: `tools/npm-dep-paths/src/cli.js` (help text, `parseArgs`, `mainWithDebug`), `tools/npm-dep-paths/test/cli.test.js`, `tools/npm-dep-paths/README.md`

**Interfaces:**
- Produces: `clearCache({ tool, cacheRoot }): Promise<void>` in `cache-clear.js`. `cacheRoot` defaults to `join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), tool)`. Removes it with `rm(cacheRoot, { recursive: true, force: true })`, logs `debugLog('cache clear')`, propagates any error other than a missing path. This exact module and signature is replicated in Tasks 2–4.
- Produces: `parseArgs` result gains `clearCache: boolean`. `main`'s `deps` gains optional `clearCache` (default: the helper) so CLI tests can stub it.

- [ ] **Step 1: Write failing helper tests** in `test/cache-clear.test.js` (use `mkdtemp` under `tmpdir()`, remove in `t.after`):
  - `removes a populated cache directory`: create `cacheRoot` with `result-1.json`; after `clearCache({ tool: 'fixture', cacheRoot })`, `stat(cacheRoot)` rejects with `ENOENT`.
  - `succeeds when the cache directory is missing`: resolves for a nonexistent path.
  - `defaults to XDG_CACHE_HOME/<tool>`: set `process.env.XDG_CACHE_HOME` to a temp dir (restore in `t.after`), create `<tmp>/fixture/x`, call `clearCache({ tool: 'fixture' })`, assert `<tmp>/fixture` is gone and a sibling `<tmp>/other/x` remains.
  - `propagates removal errors`: pass a `cacheRoot` located beneath a regular file; assert it rejects (`ENOTDIR`). Confirm on this platform that `rm` with `force` still throws for it; if not, pick another reliably failing path.
- [ ] **Step 2: Write failing CLI tests** in `test/cli.test.js`, following that file's existing `main(argv, io, deps)` style with fake stdout/stderr:
  - `--clear-cache clears once before the cache is read`: stub `deps.clearCache` recording calls and the order relative to `deps.loadProject`; assert one call, exit 0, normal report on stdout.
  - `--clear-cache with --no-cache clears then bypasses`: assert both happen and `cachedResult` wrote no file (use an injected temp `XDG_CACHE_HOME`).
  - `--clear-cache with --help prints help and does not clear`: stub never called; stdout equals help containing `--clear-cache`.
  - `--clear-cache with --version does not clear`.
  - `clear failure exits 1`: stub throws `new Error('EACCES: cannot clear')`; assert exit 1, stderr `npm-dep-paths: EACCES: cannot clear\n`, empty stdout, `loadProject` never called.
- [ ] **Step 3: Run to verify failure:** `cd tools/npm-dep-paths && node --test test/cache-clear.test.js test/cli.test.js`. Expected: FAIL (missing module; unknown option `--clear-cache`).
- [ ] **Step 4: Implement** `cache-clear.js` per the interface. In `cli.js`: add `--clear-cache` to `help` immediately after `--no-cache` with description `Delete this tool's cache before running` (keep the shared column; widen no rows unless the label is the longest — it is not). In `parseArgs` handle `--clear-cache` like `--no-cache` and return `clearCache`. In `mainWithDebug`, inside the existing `try`, after `parseArgs` and before `deps.loadProject`, call `await deps.clearCache({ tool: packageJson.name })` when `options.clearCache`; add `clearCache` to the `defaults` object.
- [ ] **Step 5: Run tests to verify pass,** same command as Step 3. Then `npm --prefix tools/npm-dep-paths test` and `npm --prefix dev-tooling run lint`. Expected: all pass, zero warnings.
- [ ] **Step 6: Inspect help:** `node tools/npm-dep-paths/bin/npm-dep-paths.js --help`; confirm columns align and `--clear-cache` is listed.
- [ ] **Step 7: Document** in `README.md`: new option, `--clear-cache` repairs entries that `--no-cache` leaves in place, whole-directory scope, cache location.
- [ ] **Step 8: Commit**

```bash
git add tools/npm-dep-paths
git commit -m "feat(paths): add --clear-cache"
```

## Task 2: `npm-dep-versions --clear-cache`

**Files:**
- Create: `tools/npm-dep-versions/src/cache-clear.js`, `tools/npm-dep-versions/test/cache-clear.test.js`
- Modify: `tools/npm-dep-versions/src/args.js`, `tools/npm-dep-versions/src/cli.js` (help, `main`), `tools/npm-dep-versions/test/args.test.js`, `tools/npm-dep-versions/test/cli.test.js`, `tools/npm-dep-versions/README.md`

**Interfaces:**
- Consumes: the `clearCache({ tool, cacheRoot })` contract from Task 1 (copied, not imported). Default directory name is the literal tool name `npm-dep-versions`.
- Produces: `parseArgs(...).clearCache: boolean` (add to the `switches` map and the initial `options`); `main`'s `deps.clearCache` stub point; `deps.cacheRoot` is also passed to the helper so tests share one injected root.

- [ ] **Step 1: Write failing tests.** `cache-clear.test.js` mirrors Task 1's four helper tests. `args.test.js`: `parseArgs(['pkg', '--clear-cache']).clearCache === true`, default `false`. `cli.test.js` mirrors Task 1's five CLI cases using `deps` stubs (`readContext`, `fetchCatalog`, `cacheRoot`); the success case additionally seeds a catalog entry in `deps.cacheRoot`, runs with `--clear-cache`, and asserts `fetchCatalog` was called (stale entry gone) and a fresh entry was written.
- [ ] **Step 2: Run to verify failure:** `cd tools/npm-dep-versions && node --test test/cache-clear.test.js test/args.test.js test/cli.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper, the parser switch, the help line (after `--no-cache`, text `Delete this tool's cache before running`, alignment preserved) and the call inside `main`'s `try`, after `parseArgs` and the help/version early return, before `realpath`/`readContext`.
- [ ] **Step 4: Run** the focused tests, then `npm --prefix tools/npm-dep-versions test` with the runtime variables from the handoff's versions command, and `npm --prefix dev-tooling run lint`. Expected: pass, zero warnings.
- [ ] **Step 5:** Inspect `--help` alignment; update README (cache section and options).
- [ ] **Step 6: Commit**

```bash
git add tools/npm-dep-versions
git commit -m "feat(versions): add --clear-cache"
```

## Task 3: `npm-dep-audit --clear-cache`

**Files:**
- Create: `tools/npm-dep-audit/src/cache-clear.js`, `tools/npm-dep-audit/test/cache-clear.test.js`
- Modify: `tools/npm-dep-audit/src/cli.js` (help, `parse`, `mainWithDebug`), `tools/npm-dep-audit/src/dep-paths.js` (`command`/`runNpmDepPaths`), `tools/npm-dep-audit/test/cli.test.js`, `tools/npm-dep-audit/test/dep-paths.test.js`, `tools/npm-dep-audit/README.md`

**Interfaces:**
- Consumes: the Task 1 helper contract. Both audit cache layers (`cache.js`, `result-cache.js`) already share `join(XDG, 'npm-dep-audit')`, so one `clearCache` call covers them.
- Produces: `parse(argv).clearCache`; `runNpmDepPaths(projectRoot, packageName, spawnImpl, platform, { noCache, clearCache })` appending `--clear-cache` to the paths argv after the existing `--no-cache` slot; `deps.clearCache` stub point on `main`.

- [ ] **Step 1: Write failing tests.** Helper tests as in Task 1. `cli.test.js`: the five CLI cases; plus `forwards clear to every paths call`: with `deps.runNpmDepPaths` recorder and an audit fixture with two packages, assert both calls receive `{ clearCache: true }` and that without the flag none do. `dep-paths.test.js`: with a fake `spawnImpl` assert argv equals `['.', 'pkg', '--format', 'json', '--clear-cache']` on Unix and that the Windows command string is `npm-dep-paths.cmd . pkg --format json --clear-cache`; with both options, both flags appear.
- [ ] **Step 2: Run to verify failure:** `cd tools/npm-dep-audit && node --test test/cache-clear.test.js test/cli.test.js test/dep-paths.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Help line after `--no-cache`. In `mainWithDebug`, call `clearCache` inside the `try` before `getAudit`, and pass `clearCache: options.clearCache` into the `runNpmDepPaths` options at the existing call site (`cli.js` where `noCache` is passed).
- [ ] **Step 4: Run** focused tests, `NPM_DEP_AUDIT_INTEGRATION=1 PATH="$PWD/tools/npm-dep-paths/bin:$PATH" npm --prefix tools/npm-dep-audit test` (with scratch variables from the handoff command), and lint. The real-paths integration run only passes once Task 1's paths is on `PATH`; that is satisfied by this worktree. Expected: pass.
- [ ] **Step 5:** Inspect `--help` alignment (this tool's label column is the widest, 34 columns; keep it); update README.
- [ ] **Step 6: Commit**

```bash
git add tools/npm-dep-audit
git commit -m "feat(audit): add --clear-cache"
```

## Task 4: `npm-dep-upgrade-plan --clear-cache`

**Files:**
- Create: `tools/npm-dep-upgrade-plan/src/cache-clear.js`, `tools/npm-dep-upgrade-plan/test/cache-clear.test.js`
- Modify: `tools/npm-dep-upgrade-plan/src/args.js`, `src/cli.js` (help, `mainWithDebug`), `src/audit.js` (`runNpmDepAudit`), `src/versions.js` (`runNpmDepVersions`), `test/args.test.js`, `test/cli.test.js`, `test/audit.test.js`, `test/versions.test.js`, `tools/npm-dep-upgrade-plan/README.md`

**Interfaces:**
- Consumes: the Task 1 helper contract (tool name `npm-dep-upgrade-plan` from `package.json`).
- Produces: `parseArgs(argv).clearCache` (the help-only return also carries `clearCache: false`); `runNpmDepAudit(projectRoot, spawnImpl, platform, { noCache, ttlMs, clearCache })` and `runNpmDepVersions(projectRoot, packageName, spawnImpl, platform, { noCache, ttlMs, now, clearCache })` appending `--clear-cache` after the `--no-cache` slot in their argv arrays.

- [ ] **Step 1: Write failing tests.** Helper tests as in Task 1. `args.test.js`: flag parses, defaults false. `audit.test.js` extending the existing argv assertion at line ~162: `{ clearCache: true }` yields `[..., '--format', 'json', '--clear-cache']`; with `noCache` too, both. `versions.test.js`: same for versions argv. `cli.test.js`: the five CLI cases, plus `forwards clear to audit and to every versions call`: stub `runNpmDepAudit`/`runNpmDepVersions` recorders with a two-package audit fixture; assert audit once and versions twice, each with `clearCache: true`; none without the flag. Add `child clear failure is fatal`: `runNpmDepAudit` stub rejects `new Error('npm-dep-audit failed')`; assert exit 1, stderr message, empty stdout.
- [ ] **Step 2: Run to verify failure:** `cd tools/npm-dep-upgrade-plan && node --test test/cache-clear.test.js test/args.test.js test/audit.test.js test/versions.test.js test/cli.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Help line after `--no-cache`: `Delete caches before running, including audit, paths, and versions`; keep the column. In `mainWithDebug`, clear inside the `try` before `readPlanningContext`/`cachedResult`; pass `clearCache: options.clearCache` in the options object of both `runNpmDepAudit` and `runNpmDepVersions` calls. Planner's cache key and TTL logic are not touched.
- [ ] **Step 4: Run** the focused tests, then the planner suite with the handoff's integration command (`NPM_DEP_AUDIT_INTEGRATION=1`, sibling bins on `PATH`, scratch variables), and lint. Expected: pass, zero warnings.
- [ ] **Step 5:** Inspect `--help`; update README's cache section (replace "A bypass does not replace existing cached entries" context with the `--clear-cache` repair path).
- [ ] **Step 6: Commit**

```bash
git add tools/npm-dep-upgrade-plan
git commit -m "feat(upgrade-plan): add --clear-cache"
```

## Task 5: `npm-dep-upgrade --clear-cache`

**Files:**
- Modify: `tools/npm-dep-upgrade/src/args.js`, `src/cli.js` (help text, call to `readPlanner`), `src/planner.js` (`readPlanner`), `test/args.test.js`, `test/planner.test.js`, `test/cli.test.js`, `tools/npm-dep-upgrade/README.md`

**Interfaces:**
- Consumes: planner CLI accepts `--clear-cache` (Task 4).
- Produces: `parseArgs(argv).clearCache === true` recorded through `assign('clearCache', true)` so it survives `resolveOptions` (it copies `cli.provided` keys; `validate` ignores unknown keys, so no config change); `readPlanner(root, run = runProcess, { clearCache = false } = {})` running `['.', '--format', 'json', ...(clearCache ? ['--clear-cache'] : [])]`. No config-file key is added.

- [ ] **Step 1: Write failing tests.** `args.test.js`: flag parses; repeated `--clear-cache` is an `INVALID_ARGUMENT` error (matching this parser's repeated-option convention); absent → `undefined`/false. `planner.test.js`: `readPlanner('/project', recorder, { clearCache: true })` passes argv `['.', '--format', 'json', '--clear-cache']`; default argv unchanged; a failing planner still raises `PLANNER_FAILED` with its stderr (child clear failure is fatal, no stale plan). `cli.test.js`: with `--clear-cache` the stubbed `d.readPlanner` receives `{ clearCache: true }`; without it, no option; `--help` text lists `--clear-cache` and `--version` ignores it.
- [ ] **Step 2: Run to verify failure:** `cd tools/npm-dep-upgrade && node --test test/args.test.js test/planner.test.js test/cli.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Help line placed directly above `--debug`: `Delete analysis caches (planner, audit, paths, versions) before running`; this label is shorter than the existing widest (`--commit-message-template <text>`), so alignment holds. In `mainWithDebug` call `d.readPlanner(project.root, undefined, { clearCache: options.clearCache })`. Leave `readFreshAudit` (`--no-cache`) and the upstream paths call in `evidence.js` unchanged: they run after the planner has already cleared the chain.
- [ ] **Step 4: Run** focused tests, `npm --prefix tools/npm-dep-upgrade test` (with the handoff's integration variables), and lint. Expected: pass.
- [ ] **Step 5:** Inspect `--help` alignment; update README (new option, and explain it targets the planner cache that `--no-cache` on the planner cannot repair).
- [ ] **Step 6: Commit**

```bash
git add tools/npm-dep-upgrade
git commit -m "feat(upgrade): add --clear-cache"
```

## Task 6: Cross-tool chain verification and repository docs

**Files:**
- Create: `tools/npm-dep-upgrade-plan/test/clear-cache.integration.test.js`
- Modify: `README.md` (root cache and debug paragraphs), `tools/npm-dep-upgrade/test/e2e/` only if an existing public-CLI case can assert it cheaply (see Step 3)

**Interfaces:**
- Consumes: all four analysis tools' real executables on `PATH`, and the fixture builders in `tools/npm-dep-upgrade-plan/test/audit.integration.test.js` (`createFixture`: project with fake `npm` audit and paths responses). Copy the helper pattern; do not export from that file.

- [ ] **Step 1: Write the failing integration test** (gated by `NPM_DEP_AUDIT_INTEGRATION === '1'` like its neighbour): set an isolated `XDG_CACHE_HOME` under the scratch root; run the real planner once to populate caches; seed a sentinel file `stale-sentinel` in each of `npm-dep-upgrade-plan`, `npm-dep-audit`, `npm-dep-paths`, `npm-dep-versions` cache directories that exist after the first run (create the directory if the fixture does not populate it, e.g. versions with no findings); run the planner with `--clear-cache --format json`; assert exit 0, no sentinel survives in any of the four directories, and a subsequent plain run writes fresh entries. Add the `--no-cache` contrast: a run with `--no-cache` leaves a sentinel in place.
- [ ] **Step 2: Run to verify** against the current branch: `NPM_DEP_AUDIT_INTEGRATION=1 PATH="$PWD/tools/npm-dep-upgrade-plan/bin:$PWD/tools/npm-dep-paths/bin:$PWD/tools/npm-dep-audit/bin:$PWD/tools/npm-dep-versions/bin:$PATH" NPM_DEP_FLOW_TEST_TMPDIR=<scratch> node --test tools/npm-dep-upgrade-plan/test/clear-cache.integration.test.js`. Expected: PASS (Tasks 1–5 already implement the behavior); to prove the test can fail, temporarily run it with `--clear-cache` removed from the planner invocation and confirm the sentinel assertion fails, then restore.
- [ ] **Step 3:** If `tools/npm-dep-upgrade/test/e2e/` has a case that runs the real planner chain against the fixture registry, add one assertion that `npm-dep-upgrade ... --clear-cache` on a project with a poisoned planner cache entry reports the fresh result. Otherwise note in the commit body that upgrade forwarding is covered by Task 5's argv tests and Task 6's planner chain, and skip.
- [ ] **Step 4: Update root `README.md`:** in the cache paragraph add that `--clear-cache` deletes a tool's cache directory and propagates through planner → audit/versions → paths and upgrade → planner, while `--no-cache` bypasses without changing stored entries; in the debug paragraph, replace the closing sentence's suggestion only if it now misleads. Keep tool READMEs from Tasks 1–5 consistent with this wording.
- [ ] **Step 5: Run** all five suites with the handoff commands and `npm --prefix dev-tooling run lint`. Expected: all pass, zero warnings.
- [ ] **Step 6: Commit**

```bash
git add README.md tools
git commit -m "test: verify cache clearing across the tool chain"
```

## Task 7: Release

**Files:**
- Modify: `package.json` and `package-lock.json` in all five `tools/npm-dep-*` directories.

- [ ] **Step 1: Confirm the base versions** against `origin/main`: `git diff origin/main -- 'tools/*/package.json'` must show no version changes yet. If main's versions moved, bump relative to the actual base.
- [ ] **Step 2: Bump each tool once:** paths 0.7.0, versions 0.2.0, audit 0.5.0, planner 0.8.0, upgrade 0.5.0, updating `package.json` `version`, and `package-lock.json` top-level `version` plus `packages[""].version`.
- [ ] **Step 3: Verify:** `node -e` check that each tool's two lockfile fields equal its `package.json` version; rerun all five suites with the handoff's commands (planner cache keys include sibling versions, so rerun after the bump) and lint. Expected: all pass, zero warnings.
- [ ] **Step 4: Commit**

```bash
git add tools/*/package.json tools/*/package-lock.json
git commit -m "chore: release --clear-cache"
```
