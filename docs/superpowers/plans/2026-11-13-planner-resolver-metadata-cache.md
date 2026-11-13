# Planner Resolver Metadata Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolver workers reuse registry packuments fetched within the planner TTL (default 1 hour), within a worker, across workers and across planner runs.

**Architecture:** A new `src/packument-cache.js` implements the Map-like `has/get/set/delete` interface that pacote calls through Arborist's `packumentCache` option, backed by gzip files under the planner cache directory. `resolver.js` puts the cache settings (directory, TTL, identity digest, or `null` under `--no-cache`) in the worker request. The worker builds one cache per process, passes it to every Arborist instance, and lowers its `freshAt` to the oldest disk entry it served. `cli.js` supplies the identity from the planning context it already computes.

**Tech Stack:** Node.js ≥20 ESM, `node:test`, `node:zlib`, `node:crypto`. npm's bundled `@npmcli/arborist` (10.x in npm 12.1.0, 9.x in npm 11.10.0; both accept `packumentCache`) and `pacote`.

**Spec:** `docs/superpowers/specs/2026-11-13-planner-resolver-metadata-cache-design.md`

## Global Constraints

- All work happens in `tools/npm-dep-upgrade-plan/` (plus root `AGENTS.md`). No sibling tool changes and no imports from sibling private modules.
- Cache location: `$XDG_CACHE_HOME/npm-dep-upgrade-plan/packuments/` (default `~/.cache/npm-dep-upgrade-plan/packuments/`). Directory mode 0700, files 0600. Writes are atomic (temp file + rename). Every storage failure is nonfatal.
- An entry is valid while `0 <= now - fetchedAt < ttlMs`. `fetchedAt` is never refreshed on reuse.
- The disk key is a digest of: cache schema `1`, the planner version, the npm version, the npm configuration digest, and pacote's key (`full:<url>` / `corgi:<url>`). Files never contain the raw pacote key, URLs, credentials or configuration values.
- `--no-cache`: no disk reads or writes, but one in-memory cache is still shared across the worker's Arborist instances. `--clear-cache` needs no new code (it already removes the whole planner cache directory).
- `preferOnline: true` stays in the worker options.
- The worker's `freshAt` is `min(request.startedAt, oldest fetchedAt served from disk)`.
- The planner's JSON schema stays at version 3, and report contents change only in freshness and expiry.
- Commit messages follow Conventional Commits. Version bump only in the final commit: planner `0.11.1` → `0.12.0`, in both `package.json` and the `package-lock.json` root metadata.
- Run shared lint (`npm --prefix dev-tooling run lint` from the repo root, zero warnings) and `npm test` in the tool for every JS change.

## Review Focus

- A registry URL with embedded credentials (`https://user:secret@host/`). The entry file must not contain `secret` or the URL. Test in Task 1.
- Two planner runs writing the same entry at once (autopilot and a manual run). A truncated or garbage `.gz` file is a miss, never a crash. Test in Task 1.
- The cache directory is unwritable (a file sits at its path, or the disk is full). The worker still resolves and reuses metadata in memory. Test in Task 1.
- pacote's corgi 404 → full retry calls `delete(key)`. It must drop both the memory and disk entries, so a later `has` is false. Test in Task 1.
- The clock moves backwards (`now < fetchedAt`). The entry is a miss, consistent with `result-cache.js`. Test in Task 1.

## Commits

1. `docs(upgrade-plan): design a TTL-bound resolver metadata cache` (done, 7587a18)
2. `docs(upgrade-plan): plan the resolver metadata cache` (this file)
3. `perf(upgrade-plan): add a TTL-bound packument store` (Task 1)
4. `perf(upgrade-plan): reuse cached registry metadata in the resolver` (Task 2)
5. `perf(upgrade-plan): key resolver metadata on the planning context` (Task 3, with docs)
6. `chore(upgrade-plan): release 0.12.0` (Task 5)

---

### Task 1: Packument store

**Files:**
- Create: `tools/npm-dep-upgrade-plan/src/packument-cache.js`
- Test: `tools/npm-dep-upgrade-plan/test/packument-cache.test.js`

**Interfaces:**
- Produces: `createPackumentCache({ dir = null, identity = null, ttlMs = 0, now = Date.now } = {})` returns `{ has(key): boolean, get(key): object|undefined, set(key, packument): void, delete(key): void, readonly oldestFetchedAt: number /* Infinity when nothing came from disk */, readonly stats: { diskHits: number, misses: number } }`. Disk use requires both `dir` and `identity` to be non-null strings. Otherwise the cache is memory-only. All methods are synchronous (pacote calls `has` synchronously).
- File name: `<sha256([1, identity, key])>.json.gz`. The gzip content is the JSON `{ fetchedAt, checksum, packument }`, where `checksum = sha256(JSON.stringify([fetchedAt, packument]))`.

- [ ] **Step 1: Write the failing tests** in `test/packument-cache.test.js`. Use a `mkdtemp` directory and a controllable `now` (start at `1000`), with `ttlMs: 100`, `identity: 'id-a'` and `key = 'corgi:https://registry.example/pkg'`.
  - `memory-only cache shares within an instance but not across instances`: with `dir: null`, `set` then `has` is true and `get` returns the same object. A second instance's `has` is false. No files are created.
  - `disk entry is served to another instance with its original fetchedAt`: A sets at 1000. B (same dir and identity) at 1050 has `has(key) === true`, `get` is deep-equal to the stored packument, `oldestFetchedAt === 1000` and `stats.diskHits === 1`.
  - `reuse never extends age`: A sets at 1000. B at 1099 hits. C at 1100 misses, and the file is deleted.
  - `clock rollback is a miss`: A sets at 1000, B at 999 misses.
  - `identity and key isolate entries`: B with `identity: 'id-b'` misses. Key `full:https://registry.example/pkg` misses after only `corgi:` was set.
  - `entry files hold no key, URL or credentials`: set key `corgi:https://user:secret@registry.example/pkg`. The gunzipped file text contains neither `secret` nor `registry.example`. On non-win32, the file mode is `0o600` and the directory mode is `0o700`.
  - `corrupt or truncated entries are misses`: write `Buffer.from('garbage')` to an entry's path, and separately the first 10 bytes of a valid gzip. Both give `has === false` and don't throw.
  - `checksum mismatch is a miss`: rewrite the entry with a changed packument but the old checksum. The result is a miss.
  - `delete drops memory and disk`: set, `delete(key)`, then a fresh instance misses.
  - `unwritable directory is nonfatal`: make `dir` a path whose parent is a regular file. `set` doesn't throw, and the same instance still serves `get` from memory.

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test test/packument-cache.test.js` (from `tools/npm-dep-upgrade-plan`)
Expected: FAIL with `Cannot find module '../src/packument-cache.js'`

- [ ] **Step 3: Implement `createPackumentCache` in `src/packument-cache.js`.** Use `readFileSync`/`gunzipSync` in `has`. Write with `mkdirSync(dir, { recursive: true, mode: 0o700 })`, `gzipSync`, `writeFileSync(tmp, …, { mode: 0o600, flag: 'wx' })` and `renameSync`, swallowing errors and unlinking the temp file. On an expired or invalid entry, best-effort `unlinkSync` it. Serialize the packument at `set` time and record `fetchedAt = now()`. Memory entries from `set` don't affect `oldestFetchedAt`. Add a header comment that the store is the planner's own and that keys are hashed so URLs with credentials never reach disk.

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test test/packument-cache.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Lint and commit**

Run: `npm --prefix ../../dev-tooling run lint`. Expected: no errors or warnings.
```bash
git add src/packument-cache.js test/packument-cache.test.js
git commit -m "perf(upgrade-plan): add a TTL-bound packument store"
```

### Task 2: Resolver request and worker wiring

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/src/resolver.js` (`resolveChoices` request body)
- Modify: `tools/npm-dep-upgrade-plan/src/resolver-worker.js` (`resolveRequest`: the `opts` build at about line 297 and the returned `freshAt`)
- Test: `tools/npm-dep-upgrade-plan/test/resolver.test.js`
- Create: `tools/npm-dep-upgrade-plan/test/resolver-cache.integration.test.js`

**Interfaces:**
- Consumes: `createPackumentCache` (Task 1).
- Produces: `resolveChoices(project, item, choices, options)` reads `options.noCache`, `options.ttlMs` and `options.packumentIdentity` (any JSON value or undefined), plus `options.env ?? process.env` for `XDG_CACHE_HOME`/`HOME`. It writes `request.packumentCache = null` when `noCache` is set or `packumentIdentity` is null/undefined. Otherwise it writes `{ dir: <cache root>/npm-dep-upgrade-plan/packuments, ttlMs, identity: sha256(JSON.stringify([1, packumentIdentity])) }`.
- Worker: `opts.packumentCache = createPackumentCache({ ...request.packumentCache })`, or a memory-only cache when the request has `null`. This one object reaches every `new Arborist(...)`, including the `{ ...opts, before }` copies in `landAncestor`. It returns `freshAt: Math.min(request.startedAt, cache.oldestFetchedAt)`. At the end it emits `debugLog(\`packument cache ${request.packumentCache ? '' : 'bypass '}diskHits=${n} misses=${m}\`)` through `./debug.js`. This summary line is the worker's only new debug output.

- [ ] **Step 1: Write the failing unit tests** in `test/resolver.test.js`. Each test stubs `options.run` to capture the request file (`JSON.parse(readFileSync(args[1]))`) and return a minimal valid result (`{ schemaVersion: 1, choices: [], coverage: { resolution: 'none' }, graph: { nodes: [] }, freshAt: 1 }`). They also stub `readRuntime`.
  - `request carries the packument cache under the planner cache root`: with `env: { XDG_CACHE_HOME: '/x' }`, `ttlMs: 5000` and `packumentIdentity: { a: 1 }`, `request.packumentCache.dir === path.join('/x', 'npm-dep-upgrade-plan', 'packuments')`, `ttlMs === 5000`, and `identity` is a 64-hex string that's stable for equal inputs and different for `{ a: 2 }`.
  - `no-cache and missing identity disable the disk cache`: `noCache: true` gives `request.packumentCache === null`, and so does omitting `packumentIdentity`.

- [ ] **Step 2: Write the failing integration test** `test/resolver-cache.integration.test.js`. It follows the `resolver.integration.test.js` pattern: a loop over `NPM_DEP_UPGRADE_E2E_NPM_CLI` and `NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI`, with `createProject(shared(true), { npmCli, installed: false }, t)` and the same `e2e-target` row and choices. Use a scratch `XDG_CACHE_HOME` under `mkdtemp(path.join(scratchRoot, 'packument-cache-'))`, merged into `f.env`. Count packument requests as `f.registry.calls.filter(c => c.phase !== 'seed' && c.method === 'GET' && !c.path.startsWith('/tarballs/') && !c.path.startsWith('/-/') && c.path !== '/__checkpoint')`.
  - `second resolve within the TTL makes no packument requests`: the first call (`ttlMs: 3600000`, `packumentIdentity: 'fixture'`) makes more than zero packument requests. Record `secondStart = Date.now()`. The second identical call adds zero. Both results are deep-equal in `choices` and `coverage`. Check `first.freshAt <= second.freshAt` and `second.freshAt < secondStart`: the second result's freshness is the first run's fetch time, not its own start.
  - `no-cache refetches and leaves no entries`: with a fresh cache dir and `noCache: true` twice, both calls make packument requests and the `packuments` directory doesn't exist afterwards.
  - `expired entries are refetched`: with `ttlMs: 1`, wait 5 ms between calls. The second call makes packument requests again.

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `node --test test/resolver.test.js` and then the integration file with both runtime variables set (see `tools/npm-dep-upgrade/README.md` Tests: `$TEST_TOOLS/npm12/...` and `npm11/...`; locally they're provisioned under `tmp/e2e-tools`).
Expected: the unit tests FAIL on `request.packumentCache` being undefined. The integration test FAILs on the second call's packument request count being greater than 0.

- [ ] **Step 4: Implement the `resolver.js` request field and the `resolver-worker.js` wiring** described under Interfaces.

- [ ] **Step 5: Run the tests to confirm they pass**, including the existing resolver suites

Run: `npm test` with both runtime variables set.
Expected: PASS. The existing `resolver*.integration.test.js` suites must also pass unchanged.

- [ ] **Step 6: Lint and commit**
```bash
git add src/resolver.js src/resolver-worker.js test/resolver.test.js test/resolver-cache.integration.test.js
git commit -m "perf(upgrade-plan): reuse cached registry metadata in the resolver"
```

### Task 3: Planning-context identity, and docs

**Files:**
- Modify: `tools/npm-dep-upgrade-plan/src/cli.js` (after `identity` is computed, before `cachedResult`)
- Test: `tools/npm-dep-upgrade-plan/test/cli.test.js`
- Modify: `tools/npm-dep-upgrade-plan/README.md` ("Cache behavior" section, and the parent-discovery paragraph about cache controls)
- Modify: `AGENTS.md` (repo root, "Working on npm-dep-upgrade-plan" cache sentence)

**Interfaces:**
- Consumes: `options.packumentIdentity` (Task 2).
- Produces: `options.packumentIdentity = identity && { planner: packageJson.version, npmVersion: identity.npmVersion, configHash: identity.configHash }`. Under `--no-cache`, `identity` is null, so this is null too. It reaches every `resolveChoices` call through the existing `options` spreads in `cli.js`, `parent-planning.js` and `angular-line-planning.js`.

- [ ] **Step 1: Write the failing test** in `test/cli.test.js`: `resolver options carry the packument identity and drop it under --no-cache`. Use `parentDeps`, with `readPlanningContext` returning `{ npmVersion: '12.1.0', configHash: 'h' }` and `resolveChoices` capturing its fourth argument. A normal run sees `packumentIdentity` deep-equal to `{ planner: <package.json version>, npmVersion: '12.1.0', configHash: 'h' }` on every captured call (at least one within-range call and one parent call). With `--no-cache`, every captured call has `packumentIdentity === null`.

- [ ] **Step 2: Run it to confirm it fails.** Run `node --test test/cli.test.js`. Expected: FAIL (`packumentIdentity` is undefined).

- [ ] **Step 3: Implement the one assignment in `cli.js`.** Run `node --test test/cli.test.js` and expect PASS.

- [ ] **Step 4: Update the docs.** The README's "Cache behavior" section should cover:
  - Resolver checks reuse registry metadata from `packuments/` until it's older than `--cache-ttl`.
  - Entries are keyed by planner version, npm version and the npm configuration digest, and store no URLs or credentials.
  - `--no-cache` skips the disk entries, and `--clear-cache` removes them with the rest of the directory.
  - Cached plans now also expire no later than the oldest metadata used.

  Add one clause to `AGENTS.md`'s planner cache sentence: the resolver's packument cache follows the planner TTL and freshness. `--help` text doesn't change.

- [ ] **Step 5: Run the full suite and lint, then commit**

Run: `npm test` (both runtime variables set) and `npm --prefix ../../dev-tooling run lint`. Expected: PASS, zero warnings.
```bash
git add src/cli.js test/cli.test.js README.md ../../AGENTS.md
git commit -m "perf(upgrade-plan): key resolver metadata on the planning context"
```

### Task 4: Measure against the baseline (no commit)

- [ ] **Step 1: Point the tool at this worktree's planner.** The installed `npm-dep-upgrade-plan` resolves to the main checkout (`which npm-dep-upgrade-plan` → `npm-dep-flow/tools/...`). Run this worktree's `bin/npm-dep-upgrade-plan.js` directly with `node`. The siblings stay as installed.
- [ ] **Step 2: Run the cold-planner measurement.** Copy fresh audit, paths and versions caches into `/home/maw/src/nrc/npm-dep-flow-impl/tmp/plan-timing-2/xdg`. First refresh them by running the installed planner once with the default cache, so they're within the TTL. Run `--debug --format json` on `/home/maw/src/nrc/uum-dep-test/webapp` with `XDG_CACHE_HOME` pointing at that copy and no `npm-dep-upgrade-plan` directory in it. Record the total time, the resolver-worker total (same aggregation as the baseline), and the `packument cache … diskHits/misses` lines.
- [ ] **Step 3: Run the warm-metadata measurement.** Delete only `xdg/npm-dep-upgrade-plan/result-*.json` and run again. This is the repeat-within-the-hour case. Record the same numbers and `du -sh xdg/npm-dep-upgrade-plan/packuments`.
- [ ] **Step 4: Check the output is unchanged.** Compare `out.json` findings with the baseline `tmp/plan-timing-1/out.json` (ignore `auditedAt`). Expected: identical findings. Baseline: 173 s total, 152.8 s across 56 resolver workers.

### Task 5: Version bump

- [ ] **Step 1: Set the planner version.** Set `"version": "0.12.0"` in `tools/npm-dep-upgrade-plan/package.json`, and in `package-lock.json` (both the root `version` and `packages[""].version`).
- [ ] **Step 2: Check the version and run the final checks.** Run `node bin/npm-dep-upgrade-plan.js --version` and expect `npm-dep-upgrade-plan v0.12.0`. Then run `npm test` and lint, expecting PASS.
- [ ] **Step 3: Commit**
```bash
git add package.json package-lock.json
git commit -m "chore(upgrade-plan): release 0.12.0"
```
