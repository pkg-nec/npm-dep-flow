# npm-dep-audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone CLI under `tools/npm-dep-audit/` that reports direct npm advisories once per exact installed package version in Markdown or JSON.

**Architecture:** Run the installed npm CLI for audit findings, join its affected node paths to lockfile package entries, and group matching direct advisories by package and version. Cache validated unfiltered audit JSON, then filter and render each request without changing the checked project.

**Tech Stack:** Node.js ES modules, `node:test`, npm CLI, npm `semver` package; no Arborist or `npm-audit-report` runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md`

**Working directory:** Create `tools/npm-dep-audit/` from the repository root before Task 1. All task file paths and shell commands below are relative to `tools/npm-dep-audit/` unless explicitly marked as repository-root paths. `../../README.md` is the repository index; this plan and its spec remain under root `docs/`.

## Global Constraints

- Support `package-lock.json` lockfile versions 2 and 3 only; reject workspaces and local `file:` or linked packages.
- Run no install command in checked projects; any install of this tool's own dependencies must use `--ignore-scripts`.
- CLI: `npm-dep-audit [project] [--format markdown|json] [--min-severity info|low|moderate|high|critical] [--cache-ttl <duration>] [--no-cache]`.
- Defaults: current directory, Markdown, minimum `info`, cache TTL `1h`.
- Each report row is one `(package, exact version)` with direct advisories only; successful audits exit 0 even with findings.
- Cache key includes the exact checked-project manifest and lockfile bytes, npm version, effective audit registry, and cache schema version; errors are never cached.
- The repository root is documentation-only: no root `package.json`, `package-lock.json`, npm workspace, or installable CLI.

## File map

- `tools/npm-dep-audit/package.json`, `tools/npm-dep-audit/package-lock.json`: CLI package, bin entry, test script, and sole runtime package dependency `semver`.
- `tools/npm-dep-audit/src/project.js`: project validation and lockfile loading.
- `tools/npm-dep-audit/src/rows.js`: path/version/advisory joining, grouping, severity selection, and ordering.
- `tools/npm-dep-audit/src/npm-audit.js`: npm subprocess calls, npm context, and audit JSON validation.
- `tools/npm-dep-audit/src/cache.js`: content fingerprint, TTL, atomic cache read/write.
- `tools/npm-dep-audit/src/render.js`: Markdown and versioned JSON output.
- `tools/npm-dep-audit/src/cli.js`, `tools/npm-dep-audit/bin/npm-dep-audit.js`: argument parsing, orchestration, stdout/stderr, exit status.
- `tools/npm-dep-audit/test/*.test.js`: focused tests using fixtures and injected subprocess/clock boundaries.
- `tools/npm-dep-audit/README.md`: installation, examples, output and limitations.
- Root `README.md`: repository overview and link to the tool's README.

## Review Focus

- One advisory affects only one of two installed versions: Task 2 tests that the other version never inherits that advisory.
- Scoped package or npm alias path: Task 2 tests the lockfile `name` field and scoped fallback name.
- npm exits 1 with a JSON `error` object: Task 3 tests that this is a failure, not a valid vulnerability result.
- Project path contains spaces or shell syntax: Task 3 tests argv spawning with `shell: false` and an explicit cwd.
- Cache file is truncated or replaced during a read: Task 4 tests safe miss and atomic replacement, without a partial report.

---

### Task 1: Project inputs and package scaffold

**Files:** Create `package.json`, `src/project.js`, `test/project.test.js`, and the tool's `README.md`; modify root `../../README.md` as a tool index.

**Interfaces:** Produce `loadProject(path: string) -> Promise<{ root: string, manifestBytes: Buffer, lockBytes: Buffer, lock: object }>`; `root` is canonical. Later tasks consume the returned object.

- [ ] **Step 1: Write failing tests.** `test/project.test.js`: a v2 and a v3 fixture each load; missing files, v1, workspaces, `file:` references, and `link: true` entries reject with named input errors. Assert the returned buffers equal the exact fixture bytes.
- [ ] **Step 2: Run `node --test test/project.test.js`.** Expect failure because `src/project.js` does not exist.
- [ ] **Step 3: Implement `loadProject(path)` and add the ESM package scaffold.** Read both target files, parse JSON, validate the checked project root and `packages`, reject unsupported local references anywhere in dependency declarations or package entries. Add `node --test` as the test script. Write the tool README and make root `../../README.md` an index pointing to it.
- [ ] **Step 4: Run `npm test`.** Expect all Task 1 tests to pass.
- [ ] **Step 5: Commit** with `git add package.json src/project.js test/project.test.js README.md ../../README.md && git commit -m "feat: validate npm project inputs"`.

### Task 2: Exact-version report rows

**Files:** Create `src/rows.js`, `test/rows.test.js`; modify `package.json`, `package-lock.json` for `semver`.

**Interfaces:** Consume `lock` from Task 1 and npm audit JSON. Produce `buildRows(lock: object, audit: object) -> Row[]` and `selectRows(rows: Row[], minSeverity: string) -> Row[]`; `Row` has `{ package, version, severity, advisories, paths }`.

- [ ] **Step 1: Write failing tests.** Fixtures include one package at `1.1.1` and `1.1.2`, two paths to `1.1.1`, two advisories with different ranges, an inherited-only `via` string, and a scoped alias. Assert exactly two version rows, paths deduped, and only the matching advisories in each. Assert a high threshold retains a row with both its high and low advisories and sorts critical before high before low.
- [ ] **Step 2: Run `node --test test/rows.test.js`.** Expect failure because `src/rows.js` does not exist.
- [ ] **Step 3: Install this tool's `semver` dependency with `npm install --ignore-scripts --save semver`; implement `buildRows` and `selectRows`.** Resolve audit node locations against `lock.packages`; prefer an entry's `name`, otherwise derive scoped or unscoped name from its last `node_modules/` segment. Match each direct advisory's `range` or `vulnerable_versions` using `semver.satisfies` with prereleases included. Reject a direct advisory with an unparseable range or an affected path lacking a version. Deduplicate advisories by source ID or URL and sort deterministically.
- [ ] **Step 4: Run `npm test`.** Expect Task 1 and Task 2 tests to pass.
- [ ] **Step 5: Commit** with `git add package.json package-lock.json src/rows.js test/rows.test.js && git commit -m "feat: group direct advisories by exact version"`.

### Task 3: npm audit adapter

**Files:** Create `src/npm-audit.js`, `test/npm-audit.test.js`.

**Interfaces:** Produce `readNpmContext(root: string, spawnImpl) -> Promise<{ version: string, registry: string }>` and `runNpmAudit(root: string, spawnImpl) -> Promise<object>`. `spawnImpl` defaults to Node's `spawn` and is injectable in tests.

- [ ] **Step 1: Write failing tests.** Assert audit argv are `audit`, `--json`, and explicit `--include=prod|dev|optional|peer` arguments, with `cwd=root` and `shell:false`. Assert a path containing spaces and `$(...)` is passed only as cwd. Exit 0 with valid audit JSON and exit 1 with valid vulnerability JSON both resolve; exit 1 with `{error: ...}`, exit 2, invalid JSON, missing `vulnerabilities`, and spawn failure reject. Assert context uses `npm --version` and the effective audit registry (`audit-registry` when set, otherwise `registry`).
- [ ] **Step 2: Run `node --test test/npm-audit.test.js`.** Expect failure because `src/npm-audit.js` does not exist.
- [ ] **Step 3: Implement `readNpmContext` and `runNpmAudit`.** Use argv spawning, bounded output capture, no shell, explicit cwd, and shape validation (`auditReportVersion`, `vulnerabilities`, `metadata`). Do not emit subprocess output to stdout.
- [ ] **Step 4: Run `npm test`.** Expect Tasks 1–3 tests to pass.
- [ ] **Step 5: Commit** with `git add src/npm-audit.js test/npm-audit.test.js && git commit -m "feat: run and validate npm audit"`.

### Task 4: Audit cache

**Files:** Create `src/cache.js`, `test/cache.test.js`.

**Interfaces:** Consume Task 1's project and Task 3's npm context. Produce `getAudit(project, context, { ttlMs, noCache, cacheRoot, now, fetchAudit }) -> Promise<{ audit: object, auditedAt: string }>`; `fetchAudit` defaults to `runNpmAudit(project.root)`.

- [ ] **Step 1: Write failing tests.** Assert first call fetches and second call within 3,600,000 ms hits cache; a one-byte manifest or lockfile change, npm version change, registry change, or expiry refetches. Assert `noCache` neither reads nor writes. Assert a truncated cache is a miss, failed fetch never creates an entry, and replacement leaves only complete JSON visible.
- [ ] **Step 2: Run `node --test test/cache.test.js`.** Expect failure because `src/cache.js` does not exist.
- [ ] **Step 3: Implement `getAudit`.** SHA-256 a domain-separated fingerprint, store per canonical project under `XDG_CACHE_HOME` or the user's `.cache` directory, use mode 0700 directory and 0600 files, and rename a same-directory temporary file atomically. Validate cache shape on read; treat corruption as a miss, but never serve an expired entry after fetch failure.
- [ ] **Step 4: Run `npm test`.** Expect Tasks 1–4 tests to pass.
- [ ] **Step 5: Commit** with `git add src/cache.js test/cache.test.js && git commit -m "feat: cache validated audit data"`.

### Task 5: Human and machine output

**Files:** Create `src/render.js`, `test/render.test.js`.

**Interfaces:** Consume selected `Row[]` and `auditedAt`. Produce `renderMarkdown(rows: Row[]) -> string` and `renderJson(rows: Row[], auditedAt: string) -> string` with `schemaVersion: 1`.

- [ ] **Step 1: Write failing tests.** Assert the Markdown header is `Package | Version | Highest severity | Advisories | Installed paths`, advisory titles link to URLs, repeated paths stay in one row, and table metacharacters in package/title/path are escaped. Assert empty rows state no matching direct advisories. Parse JSON and assert `schemaVersion === 1`, `auditedAt`, and each row's `package`, `version`, `severity`, `advisories` (`id`, `title`, `url`, `severity`, `range`), and `paths`.
- [ ] **Step 2: Run `node --test test/render.test.js`.** Expect failure because `src/render.js` does not exist.
- [ ] **Step 3: Implement `renderMarkdown` and `renderJson`.** Preserve Task 2's ordering, use only direct advisory fields, and append one trailing newline.
- [ ] **Step 4: Run `npm test`.** Expect Tasks 1–5 tests to pass.
- [ ] **Step 5: Commit** with `git add src/render.js test/render.test.js && git commit -m "feat: render Markdown and JSON reports"`.

### Task 6: CLI and documentation

**Files:** Create `src/cli.js`, `bin/npm-dep-audit.js`, `test/cli.test.js`; modify `package.json`, `README.md`.

**Interfaces:** `main(argv: string[], io = process, deps = defaultDeps) -> Promise<number>` connects Tasks 1–5; bin sets `process.exitCode` to its result. A successful report writes once to stdout; errors write once to stderr with no partial stdout.

- [ ] **Step 1: Write failing tests.** Assert defaults, a supplied project path, JSON format, `--min-severity high`, `--cache-ttl 30m`, and `--no-cache` pass the right values to injected dependencies. Assert `--help` exits 0 without auditing; unknown options, invalid format/severity/duration, and audit failures return nonzero with empty stdout. A fixture integration test runs the real bin with a mocked npm executable and lockfile and asserts one Markdown row per exact version plus valid JSON on the second invocation.
- [ ] **Step 2: Run `node --test test/cli.test.js`.** Expect failure because the CLI modules do not exist.
- [ ] **Step 3: Implement `main` and the bin; document use in `README.md`.** Parse `s|m|h|d` cache durations into positive milliseconds, set the package bin mapping, document stdout/exit contracts and unsupported inputs. Never modify the checked project.
- [ ] **Step 4: Run `npm test` and `node bin/npm-dep-audit.js --help`.** Expect all tests pass and help lists the agreed options.
- [ ] **Step 5: Commit** with `git add src/cli.js bin/npm-dep-audit.js test/cli.test.js package.json README.md && git commit -m "feat: expose npm-dep-audit CLI"`.

## Final verification

- [ ] Run `npm test` and confirm every test passes.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run `node bin/npm-dep-audit.js /path/to/controlled/project --format json --no-cache` from the tool directory and confirm valid version rows; do not use a maintained production project as the fixture.
- [ ] Review the branch against the spec and confirm the checked project's manifest and lockfile are unchanged.
- [ ] Confirm the repository root has no `package.json` or `package-lock.json`, and the root README links to `tools/npm-dep-audit/README.md`.
