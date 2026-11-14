# Autopilot `--ignore` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator permanently mark a finding as "do not attempt" so `npm-dep-autopilot` stops being blocked by an upgrade that breaks the project.

**Architecture:** A per-clone JSON store under autopilot's own cache directory holds `<module>:<id>` ignore entries with no expiry. `npm-dep-autopilot --config <path> --ignore <module>:<id>` appends to it and exits without taking the lock, so a waiting instance keeps running; that instance re-reads the store at every candidate selection, so a new entry takes effect on its next work cycle. Separately, `publish()` stops re-deriving the pull request body from `git log` and works from an in-memory list of what autopilot actually applied, which is also what gives each body line its finding ID.

**Tech Stack:** Node.js 20+, ESM, `node:test`, no runtime dependencies. Shared ESLint from `dev-tooling`.

**Spec:** `docs/superpowers/specs/2026-11-13-autopilot-ignore-findings-design.md`

## Global Constraints

- All work is in `tools/npm-dep-autopilot/`. Never import a sibling tool's private module; sibling tools are reached only through their CLIs.
- Node.js 20 or newer. ESM. No new runtime dependencies.
- Shared lint must pass with zero warnings: `npm --prefix dev-tooling run lint` from the repository root.
- Tests run with `npm test` (which is `node --test`) from `tools/npm-dep-autopilot/`. Unless a step says otherwise, `npm` commands run from there and `git` commands run from the repository root, where the paths in every `git add` are written.
- Commit messages use Conventional Commits headers, scope `autopilot`.
- Bump `tools/npm-dep-autopilot` exactly once, in the final commit, minor (0.1.0 → 0.2.0), with `package.json` and `package-lock.json` root metadata in sync.
- Cache root is `$XDG_CACHE_HOME/npm-dep-autopilot`, falling back to `~/.cache/npm-dep-autopilot`, matching the sibling tools.
- Store filename: `ignored-<digest>.json`, `<digest>` = `sha256(JSON.stringify(resolve(repo)))` as 64 lowercase hex characters, `repo` being the clone's resolved absolute path.
- An unreadable store always means zero entries and never a nonzero exit.
- Code must stay portable to Windows even though the executable tests are skipped there.

## Review Focus

1. `--ignore :<id>` for the empty-module project — the leading colon is easy to parse as a missing module; it must store `module: ""`. Covered in Task 2.
2. An ID that is not 7–64 lowercase hex (`ABC1234`, `a1b2c3`, `zzzzzzz`) must be rejected at the CLI, not stored and silently never matched. Covered in Task 2.
3. A missing cache directory on the first `--ignore` must be created, not crash the command. Covered in Task 1.
4. The run and the `--ignore` command must resolve the same path for the same clone, including when `XDG_CACHE_HOME` is unset — otherwise a stored ignore is never seen. Covered in Task 1.
5. A full 64-character ID stored as the entry must match the finding exactly, as the prefix rule degenerates to equality. Covered in Task 4.

---

### Task 1: The ignore store

**Files:**
- Create: `tools/npm-dep-autopilot/src/ignores.js`
- Test: `tools/npm-dep-autopilot/test/ignores.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `cacheRoot(env = process.env)` → `string`, the autopilot cache directory.
  - `storePath(repo, root = cacheRoot())` → `string`, the clone's `ignored-<digest>.json`.
  - `readIgnores(repo, root = cacheRoot())` → `Promise<{ entries: Array<{ module: string, id: string, addedAt: string }>, unreadable: boolean }>`. Missing file: `{ entries: [], unreadable: false }`. Anything else that fails: `{ entries: [], unreadable: true }`.
  - `addIgnores(repo, items, root = cacheRoot(), now = () => new Date())` → `Promise<{ added: Array<{module,id}>, duplicates: Array<{module,id}>, rebuilt: boolean }>`, where `items` is `Array<{ module: string, id: string }>`.
  - `isIgnored(entries, module, id)` → `boolean`.

- [ ] **Step 1: Commit the approved design doc**

```bash
git add docs/superpowers/specs/2026-11-13-autopilot-ignore-findings-design.md docs/superpowers/plans/2026-11-13-autopilot-ignore-findings.md
git commit -m "docs(autopilot): add the ignore-findings design and plan"
```

- [ ] **Step 2: Write the failing tests**

In `test/ignores.test.js`, using `mkdtemp` for an isolated root:

```js
test('storePath names the file by a 64-hex digest of the resolved repo path')
// assert /ignored-[0-9a-f]{64}\.json$/ and that two different repos differ,
// and that storePath('/srv/repo-a') is stable across calls.

test('cacheRoot honours XDG_CACHE_HOME and falls back to the home directory')
// cacheRoot({ XDG_CACHE_HOME: '/x' }) === '/x/npm-dep-autopilot'
// cacheRoot({ HOME: '/h' }) === '/h/.cache/npm-dep-autopilot'

test('reading a missing store yields no entries and is not unreadable')
test('addIgnores creates the cache directory and writes version, repo and entries')
// Read the file back: { version: 1, repo, entries: [{ module, id, addedAt }] }
// addedAt is the injected now as an ISO string.

test('addIgnores appends to an existing store and reports duplicates')
// Add web:a1b2c3d, then add web:a1b2c3d and api:0d1e2f3 in one call:
// added = [api entry], duplicates = [web entry], file holds 2 entries.

test('overlapping prefixes are stored as separate entries')
// web:a1b2c3d then web:a1b2c3d4ef => 2 entries, no duplicates reported.

test('an unreadable store reads as zero entries', ...)
// Table-driven over: invalid JSON, a JSON array, a missing entries array,
// an entry missing module, an entry whose id is not a string,
// { version: 2, ... }, and a repo field naming a different clone.
// Each: entries = [], unreadable = true.

test('writing over an unreadable store rebuilds it with only the new entries')
// rebuilt === true and the file holds exactly the added entry.

test('isIgnored matches on equal module and an id prefix')
// ('web','a1b2c3d') matches row id 'a1b2c3d...'; different module does not;
// a full 64-char entry matches only the identical id; 'a1b2c3e' does not match.
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- test/ignores.test.js` from `tools/npm-dep-autopilot/`
Expected: FAIL, cannot find module `../src/ignores.js`.

- [ ] **Step 4: Implement `src/ignores.js`**

Validation on read is strict and total: the parsed value must be an object with `version === 1`, a `repo` equal to the passed repo, and an `entries` array whose every element is an object with string `module`, string `id` matching `/^[0-9a-f]{7,64}$/` and string `addedAt`. Any deviation returns `{ entries: [], unreadable: true }`; nothing throws.

Writes create the directory with `mkdir(..., { recursive: true })`, write a sibling temporary file, then `rename` it over the target. Use `createHash` from `node:crypto` for the digest. Do not add a `checksum` field and do not add any expiry fields.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/ignores.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/npm-dep-autopilot/src/ignores.js tools/npm-dep-autopilot/test/ignores.test.js
git commit -m "feat(autopilot): add the per-clone ignore store"
```

---

### Task 2: The `--ignore` command

**Files:**
- Modify: `tools/npm-dep-autopilot/src/cli.js` (`helpBody`, `parseArgs`, `main`)
- Test: `tools/npm-dep-autopilot/test/cli.test.js`

**Interfaces:**
- Consumes: `addIgnores`, `storePath` from Task 1.
- Produces: `parseArgs` returns `args.ignore` as `Array<{ module: string, id: string }>` (empty when the flag is absent).

- [ ] **Step 1: Write the failing tests**

In `test/cli.test.js`, alongside the existing `runCli`/`writeConfig` helpers. The existing alignment test asserts `rows.length === 6`; update it to `7`.

```js
test('--ignore stores an entry and exits without running', ...)
// runCli(['--config', file, '--ignore', 'web:a1b2c3d'], { ...env, XDG_CACHE_HOME: dir })
// code 0; stdout names the entry; the store file holds one entry;
// no planner or upgrade command ran (assert the fake state dir recorded none).

test('--ignore does not take the single-instance lock', ...)
// Acquire the lock for the clone first (as the existing lock test does),
// then run --ignore: still exit 0 and the entry is stored.

test('repeated --ignore stores every entry', ...)   // two flags, two entries
test('--ignore=<value> is accepted', ...)
test('--ignore :<id> stores the empty-module project', ...)
// config with projects: [{ path: '.', module: '' }]; entry module is ''.

test('--ignore reports an already stored entry without duplicating it', ...)

test('--ignore rejects a bad value', ...)
// Table: 'a1b2c3d' (no colon), 'web:a1b2c3' (6 chars), 'web:ABC1234'
// (uppercase), 'web:zzzzzzz' (not hex), 'nope:a1b2c3d' (unknown module).
// Each: code 1, stderr names the problem, no store file written.

test('--ignore without --config is a usage error', ...)
test('--ignore with --clear-cache is a usage error', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/cli.test.js`
Expected: FAIL, `Unknown argument: --ignore`.

- [ ] **Step 3: Add `--ignore` to `parseArgs` in `src/cli.js`**

Accept `--ignore <value>` and `--ignore=<value>`, collecting into `args.ignore`. Split each value at the **first** `:` so a leading colon yields `module: ''`. Validate the id against `/^[0-9a-f]{7,64}$/`. Throw `AutopilotError(..., 'USAGE')` for a value with no colon, a bad id, or `--ignore` together with `--clear-cache`. The module is validated later, against the loaded config.

- [ ] **Step 4: Add the `--ignore` row to `helpBody`**

`  --ignore <module>:<id>  Never attempt this finding again; cleared only by --clear-cache`

This label is longer than any existing one, so re-pad every option row to keep one common description column with at least two spaces after the longest label.

- [ ] **Step 5: Handle `--ignore` in `main` in `src/cli.js`**

Inside `runDebug`, after `loadConfig` and **before** `acquireLock`: when `args.ignore.length > 0`, reject any module not present in `config.projects` with an `AutopilotError(..., 'USAGE')` naming the configured modules, call `addIgnores(config.repo, args.ignore)`, write one stdout line per added and per duplicate entry, and return 0. Do not create `gh`, `git` or `tools`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- test/cli.test.js`
Expected: PASS

- [ ] **Step 7: Inspect the rendered help**

Run: `node bin/npm-dep-autopilot.js --help`
Expected: every option description starts at the same column, at least two spaces after `--ignore <module>:<id>`.

- [ ] **Step 8: Commit**

```bash
git add tools/npm-dep-autopilot/src/cli.js tools/npm-dep-autopilot/test/cli.test.js
git commit -m "feat(autopilot): add --ignore to record a finding to skip"
```

---

### Task 3: Clearing autopilot's own cache

**Files:**
- Create: `tools/npm-dep-autopilot/src/cache-clear.js`
- Modify: `tools/npm-dep-autopilot/src/cli.js` (both `--clear-cache` paths)
- Test: `tools/npm-dep-autopilot/test/cli.test.js`

**Interfaces:**
- Consumes: `cacheRoot`, `storePath` from Task 1.
- Produces:
  - `clearStore(repo, root = cacheRoot())` → `Promise<void>`, removes one clone's store.
  - `clearAllStores(root = cacheRoot())` → `Promise<void>`, removes the whole autopilot cache directory.

- [ ] **Step 1: Write the failing tests**

```js
test('--clear-cache with --config removes only this clone\'s store', ...)
// Seed two store files (two different repo paths), run --clear-cache --config,
// assert this clone's file is gone and the other remains, and that the run
// then proceeds normally (the existing clear-cache test's expectations hold).

test('--clear-cache alone removes every store', ...)
// Seed two store files, run --clear-cache with no config,
// assert the cache directory is gone and exit code 0.

test('--clear-cache succeeds when no store file exists', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/cli.test.js`
Expected: FAIL, store files still present after clearing.

- [ ] **Step 3: Implement `src/cache-clear.js`**

Both functions use `rm(..., { recursive: true, force: true })` so a missing path is not an error, and call `debugLog` the way `tools/npm-dep-audit/src/cache-clear.js` does. A failure propagates and becomes exit 1 through the existing handler.

- [ ] **Step 4: Wire both `--clear-cache` paths in `src/cli.js`**

In the no-config branch, call `clearAllStores()` before `createTools(...).clearCache()`. In the config branch, call `clearStore(config.repo)` next to the existing `tools.clearCache()` call, after the lock, `gh` and identity checks.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/cli.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/npm-dep-autopilot/src/cache-clear.js tools/npm-dep-autopilot/src/cli.js tools/npm-dep-autopilot/test/cli.test.js
git commit -m "feat(autopilot): clear stored ignores with --clear-cache"
```

---

### Task 4: Selection honours ignores

**Files:**
- Modify: `tools/npm-dep-autopilot/src/selector.js` (`rankCandidates`)
- Test: `tools/npm-dep-autopilot/test/selector.test.js`

**Interfaces:**
- Consumes: `isIgnored` from Task 1.
- Produces: `rankCandidates(entries, severity, skip, ignores = [])` → `{ candidates: Array<{project,row,kind}>, ignored: Array<{project,row}> }`. `drainCandidates(candidates, module)` is unchanged and still takes a plain array.

- [ ] **Step 1: Write the failing tests**

Existing tests destructure the array return; update them to read `.candidates`. Add:

```js
test('an ignored row is not a candidate and is reported as ignored')
// ignores [{module:'web',id:'a1b2'}] against web rows 'a1b2c3' and 'b000';
// candidates has only 'b000'; ignored has only 'a1b2c3'.

test('an ignore only applies to its own module')
test('a full-length ignore id matches only the identical row id')
test('ignored rows are reported even when the severity yields no candidates')
test('a row that is both skipped and ignored is reported as ignored, not dropped silently')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/selector.test.js`
Expected: FAIL, `rankCandidates(...).candidates` is undefined.

- [ ] **Step 3: Change `rankCandidates` in `src/selector.js`**

Partition the severity's complete rows into ignored and not, using `isIgnored(ignores, project.module, row.id)`; apply the existing `skip` filter, ranking and ordering to the remainder only. The ignore test runs before the skip test so an ignored row is always reported.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/selector.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/npm-dep-autopilot/src/selector.js tools/npm-dep-autopilot/test/selector.test.js
git commit -m "feat(autopilot): filter ignored findings out of selection"
```

---

### Task 5: The applied-upgrade list drives title and body

**Files:**
- Modify: `tools/npm-dep-autopilot/src/naming.js` (`prPlan`, new `prBody`)
- Modify: `tools/npm-dep-autopilot/src/runner.js` (`attemptUpgrade`, `publish`, `workCycle`)
- Modify: `tools/npm-dep-autopilot/src/selector.js` (`publishesImmediately`)
- Test: `tools/npm-dep-autopilot/test/naming.test.js`, `tools/npm-dep-autopilot/test/runner.test.js`

**Interfaces:**
- Consumes: `rankCandidates` from Task 4.
- Produces:
  - An **applied item**: `{ id, severity, kind, package, oldVersion, actions, commits }` where `commits` is `Array<string>` of subjects, built in `attemptUpgrade` from the upgrade report plus the candidate's severity and kind.
  - `prPlan({ module, items })` → `{ branch, title }`.
  - `prBody(items)` → `string`.
  - `publishesImmediately(item)` → `boolean`.

- [ ] **Step 1: Write the failing tests**

In `test/naming.test.js`, keep every existing title and branch expectation and re-express the inputs as item lists:

```js
test('prBody puts the finding id on each commit line')
// items: one with id 'a1b2c3d…' and two commit subjects, one with '9f8e7d6…'
// and one subject =>
// "- s1 (a1b2c3d)\n- s2 (a1b2c3d)\n- s3 (9f8e7d6)"

test('prPlan uses the per-package title for a single item')
test('prPlan uses the per-package title for several items with one commit in total')
test('prPlan uses the fix-vulnerabilities title for several items and several commits')
test('prPlan still prefers the Angular toolchain and runtime titles')
test('publishesImmediately is true for a critical item and for any non-package kind')
```

In `test/runner.test.js`, update the body assertion (currently `'- subject one'`) to expect the ID tail, and keep every other expectation unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/naming.test.js test/runner.test.js`
Expected: FAIL, `prBody` is not exported and bodies have no ID tails.

- [ ] **Step 3: Implement `prBody` and change `prPlan` in `src/naming.js`**

`prBody` emits one `- <subject> (<first 7 chars of item.id>)` line per commit, items in order, commits in order. `prPlan` takes the item list in place of `reports` plus `kind` plus `singleFinding`: the Angular branch uses `items[0].kind` and searches `items.flatMap(item => item.actions)` exactly as `angularPlan` does today; the per-package versus `fix-vulnerabilities` choice uses `items.length !== 1 && commitCount !== 1`, which is the current condition with `singleFinding` replaced by `items.length === 1`.

- [ ] **Step 4: Change `publishesImmediately` in `src/selector.js`**

Take one item and read `severity` and `kind` off it.

- [ ] **Step 5: Build and use the list in `src/runner.js`**

`attemptUpgrade` returns the applied item instead of the raw report, carrying `severity` and `kind` from the candidate. `workCycle` accumulates items where it accumulates `reports` today. `publish` takes `{ module, items }`, calls `prPlan({ module, items })` and `prBody(items)`, and no longer calls `git.subjectsSince()`. Delete `subjectsSince` from `src/git.js` and its test, since nothing calls it.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add tools/npm-dep-autopilot/src tools/npm-dep-autopilot/test
git commit -m "refactor(autopilot): drive pull request text from the applied upgrades

The body now carries each commit's finding id, taken from the upgrade
report that produced it rather than re-derived from git log."
```

---

### Task 6: The runner loads, reloads, logs and reports ignores

**Files:**
- Modify: `tools/npm-dep-autopilot/src/runner.js` (`selectFirst`, `selectDrain`, `workCycle`, `runAutopilot`)
- Test: `tools/npm-dep-autopilot/test/runner.test.js`

**Interfaces:**
- Consumes: `readIgnores` from Task 1, `rankCandidates` from Task 4.
- Produces: `runAutopilot` accepts `loadIgnores` in its context object, a `() => Promise<{ entries, unreadable }>` the tests inject; the default closes over `config.repo` and calls `readIgnores`.

- [ ] **Step 1: Write the failing tests**

```js
test('an ignored finding is never upgraded', ...)
// loadIgnores returns one entry; assert no upgrade event for it and that
// the other finding is upgraded and published.

test('an ignore added between cycles is honoured without a restart', ...)
// loadIgnores returns [] on the first call and the entry afterwards;
// the first cycle publishes the finding, the second does not re-attempt it.

test('each work cycle logs one line naming the ignored findings', ...)
// 'Ignoring 1 finding(s): web:a1b2c3d (brace-expansion@5.0.9)'
// exactly once per cycle, and for a cycle that publishes nothing.

test('a cycle that ignores nothing logs no ignoring line', ...)

test('an unreadable store warns once per run and keeps working', ...)
// loadIgnores returns { entries: [], unreadable: true } every call;
// exactly one warning line names the store path across several cycles.

test('a restart clears runtime skips but not ignores', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/runner.test.js`
Expected: FAIL, no ignoring line is logged.

- [ ] **Step 3: Thread ignores through `src/runner.js`**

`selectFirst` and `selectDrain` call `loadIgnores()` and pass the returned `entries` to `rankCandidates` as its fourth argument, collecting the returned `ignored` rows into a per-cycle collection keyed `<module>:<id>` so a drain does not duplicate them. At the end of a work cycle, whether it published or not, log one line when that collection is non-empty:

`Ignoring <n> finding(s): <module>:<7 digits> (<package>@<version>), …`

Keep the ignore entries out of the `skip` set so the restart path's `skip.clear()` cannot touch them.

- [ ] **Step 4: Add the warning latch and the debug record**

Hold a per-run flag so an `unreadable` result logs `Cannot read the ignore store <path>; continuing with no ignored findings` only once, reset when a later read succeeds. Write a `debugLog` record at the first read of each cycle and whenever the entry list differs from the previously recorded one, listing each entry's module, id and `addedAt`.

- [ ] **Step 5: Add the `loadIgnores` default in `src/cli.js`**

Pass `loadIgnores: () => readIgnores(config.repo)` into `runAutopilot`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Add the end-to-end executable test**

In `test/cli.test.js`, with the existing fakes: store an ignore with `--ignore`, then run the app against a plan containing that finding plus another, and assert the ignored one is never upgraded and the log carries the `Ignoring` line.

Run: `npm test -- test/cli.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add tools/npm-dep-autopilot/src tools/npm-dep-autopilot/test
git commit -m "feat(autopilot): skip ignored findings and report them each cycle"
```

---

### Task 7: Documentation

**Files:**
- Modify: `tools/npm-dep-autopilot/README.md`
- Modify: `AGENTS.md` (the `npm-dep-autopilot` section)
- Modify: `README.md` (root) only if it lists autopilot's options

- [ ] **Step 1: Update the autopilot README**

Add `npm-dep-autopilot --config ./autopilot.json --ignore web:a1b2c3d` to the usage block. Add an **Ignoring a finding** section covering: the `<module>:<id>` value and the empty-module `:<id>` form; where the ID is read from (the pull request body's tail, or `npm-dep-upgrade-plan`); that the command does not take the lock and does not start a run; that a running instance picks the entry up on its next work cycle; the ignore-then-close-the-pull-request ordering and why; that entries never expire; the store path and per-clone file; that prefixes match; and that `--clear-cache` is the only removal, all-or-nothing per clone. State the consequence of losing the store: the breaking upgrade is attempted again, and the warning line is the signal to re-add.

In **Behavior**, note the per-cycle `Ignoring …` line and that pull request body lines now end with the finding's seven-digit ID. In the `--clear-cache` paragraph, note that with `--config` it removes that clone's ignores and alone it removes every clone's. Extend the exit-code table with the `--ignore` usage errors.

- [ ] **Step 2: Update `AGENTS.md`**

In the autopilot section, one line: the per-clone ignore store under the autopilot cache directory, read at every selection, never expiring, removed only by `--clear-cache`, and that pull request bodies carry finding IDs from the applied-upgrade list rather than from `git log`.

- [ ] **Step 3: Verify the documented commands**

Run: `node bin/npm-dep-autopilot.js --help`
Expected: the output matches what the README shows, with aligned descriptions.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md tools/npm-dep-autopilot/README.md
git commit -m "docs(autopilot): document --ignore and the ignore store"
```

---

### Task 8: Verification and version bump

**Files:**
- Modify: `tools/npm-dep-autopilot/package.json`
- Modify: `tools/npm-dep-autopilot/package-lock.json`

- [ ] **Step 1: Run the full tool suite**

Run: `cd tools/npm-dep-autopilot && npm ci --ignore-scripts && npm test`
Expected: PASS, no skipped assertions beyond the existing Windows guards.

- [ ] **Step 2: Run shared lint**

Run: `npm --prefix dev-tooling ci --ignore-scripts && npm --prefix dev-tooling run lint` from the repository root
Expected: zero errors and zero warnings.

- [ ] **Step 3: Bump the version**

Set `version` to `0.2.0` in `tools/npm-dep-autopilot/package.json` and in the root metadata of `tools/npm-dep-autopilot/package-lock.json` (both the top-level `version` and `packages[""].version`). This is a new capability, so it is a minor bump, and it is the only version change in this branch.

- [ ] **Step 4: Confirm the tree is clean and the suite still passes**

Run: `npm test` in `tools/npm-dep-autopilot`, then `git status --porcelain`
Expected: PASS, and only the two version files modified.

- [ ] **Step 5: Commit**

```bash
git add tools/npm-dep-autopilot/package.json tools/npm-dep-autopilot/package-lock.json
git commit -m "chore(autopilot): release 0.2.0"
```
