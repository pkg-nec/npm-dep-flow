# npm-dep-upgrade-plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `npm-dep-upgrade-plan` CLI that reports, per vulnerable package version and target installation location, whether an ordered remediation strategy can resolve that installation.

**Architecture:** Create an independent tool under `tools/npm-dep-upgrade-plan/`. Its CLI consumes `npm-dep-audit` schema v2 JSON through the public command, queries `npm view` for versions and release times per affected package, groups requirements by target location, evaluates locations with an ordered strategy registry, and renders Markdown or versioned JSON only after all work succeeds.

**Tech Stack:** Node.js 20+ ES modules, `node:test`, `semver` `^7.8.5`, npm subprocesses.

**Spec:** `docs/superpowers/specs/2026-10-13-npm-dep-upgrade-plan-design.md`

## Global Constraints

- Support ordinary single-package npm projects with `package-lock.json` lockfile versions 2 or 3; inherit `npm-dep-audit` restrictions for workspaces, local links, shrinkwrap files, and other package managers.
- The planner invokes the separately installed `npm-dep-audit` CLI with `--min-severity info --format json` and validates schema version 2.
- The command is `npm-dep-upgrade-plan [project] [--format markdown|json]`; project defaults to the current directory and Markdown is the default format.
- Consider only strict semantic versions that are stable; exclude prereleases and values that are not semantic versions.
- `minimumSafeVersion` must be a stable version newer than the installed version and outside every advisory range on the finding; it is null if none exists. Its registry release time is null when unavailable.
- Emit one row per `(package, version, targetLocation)`. A strategy is eligible only when one candidate satisfies every declared requirement for that target location. Set `strategy` to null when no strategy applies.
- Do not install dependencies, run lifecycle scripts, modify the target project, or change `tools/npm-dep-audit/`.
- Use argument-array subprocesses on Unix-like systems and the repository's `.cmd` shell pattern on Windows; never put the target project path in shell command text.
- Install dependencies in the new tool only with `npm ci --ignore-scripts` or `npm install --package-lock-only --ignore-scripts`.
- Put task scratch files under `/home/maw/src/nrc/npm-dep-flow-impl/tmp`; put any execution worktree under `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`.

## Review Focus

- A project-root dependent has `location: ""`; accept the empty location as a string and preserve it. Task 3 tests this audit link.
- Scoped package names must remain safe in registry queries on Windows; Task 4 tests the package validation and `.cmd` invocation.
- `npm view ... versions --json` can return one JSON string instead of an array; Task 4 normalizes both forms and tests the scalar response. Release times come from the registry `time` object; missing or invalid version timestamps are null.
- A semver union can exclude the package-level minimum safe version but admit a later safe version; the strategy target can therefore differ from `minimumSafeVersion`.
- A later registry query can fail after earlier package queries succeeded; Task 7 asserts the CLI emits no partial stdout.

---

## File Map

- Create `tools/npm-dep-upgrade-plan/package.json` and `package-lock.json` for this independent Node.js project and its `semver` dependency.
- Create `tools/npm-dep-upgrade-plan/bin/npm-dep-upgrade-plan.js` as the executable entry point.
- Create `tools/npm-dep-upgrade-plan/src/args.js` for CLI parsing and `src/cli.js` for orchestration.
- Create `tools/npm-dep-upgrade-plan/src/process.js` for portable subprocess execution.
- Create `tools/npm-dep-upgrade-plan/src/audit.js` for invoking and validating the `npm-dep-audit` JSON contract.
- Create `tools/npm-dep-upgrade-plan/src/registry.js` for `npm view`, stable-version normalization, and release-time normalization.
- Create `tools/npm-dep-upgrade-plan/src/strategies.js` for the ordered strategy registry and `update-within-declared-range` evaluator.
- Create `tools/npm-dep-upgrade-plan/src/evaluate.js` to attach strategy results to every affected link.
- Create `tools/npm-dep-upgrade-plan/src/report.js` to sort findings deterministically and render Markdown and JSON.
- Create focused tests under `tools/npm-dep-upgrade-plan/test/` for args, process, audit, registry, strategy evaluation, rendering, and CLI orchestration.
- Create `tools/npm-dep-upgrade-plan/README.md` and update the root `README.md` tool index in the final task.

### Task 1: Scaffold the CLI project and parse arguments

**Files:** Create `tools/npm-dep-upgrade-plan/package.json`, `package-lock.json`, `src/args.js`, and `test/args.test.js`.

**Interfaces:**

- `parseArgs(argv: string[], cwd: string = process.cwd()) -> { projectPath: string, format: 'markdown'|'json', help: boolean }`.

- [ ] **Step 1: Create the tool manifest and lockfile.** Set `name` to `npm-dep-upgrade-plan`, `private: true`, `type: module`, `engines.node` to `>=20`, `scripts.test` to `node --test`, and dependency `semver` to `^7.8.5`. Generate `package-lock.json` with `npm install --package-lock-only --ignore-scripts`, then install the tool's dependencies with `npm ci --ignore-scripts` from this tool directory. Add the `bin` mapping with the executable in Task 7.

- [ ] **Step 2: Write failing argument tests in `test/args.test.js`.** Cover default project path and Markdown format; explicit project path and JSON format; `--help` short-circuiting argument parsing; missing `--format` value; unsupported format; unknown option; and more than one positional project path.

- [ ] **Step 3: Run `npm test -- --test-name-pattern="argument"` from `tools/npm-dep-upgrade-plan/`.** Expect failure because `src/args.js` does not exist yet.

- [ ] **Step 4: Implement `parseArgs` in `src/args.js`.** If `argv` contains `--help`, return `help: true` before validating other arguments. Otherwise accept only `--format markdown|json`; default `projectPath` to `cwd` and `format` to `markdown`; reject unknown flags and multiple project paths.

- [ ] **Step 5: Run `npm test` from `tools/npm-dep-upgrade-plan/`.** Expect all argument tests to pass.

- [ ] **Step 6: Commit.** Stage the manifest, lockfile, parser, and tests; commit `feat: scaffold npm-dep-upgrade-plan`.

### Task 2: Add the portable subprocess runner

**Files:** Create `tools/npm-dep-upgrade-plan/src/process.js` and `test/process.test.js`.

**Interfaces:**

- `runProcess(commandName: string, args: string[], cwd: string, spawnImpl = spawn, platform = process.platform) -> Promise<{ code: number|null, stdout: string, stderr: string }>`.

- [ ] **Step 1: Write failing tests in `test/process.test.js`.** Use `EventEmitter` and `PassThrough` fakes to assert Unix uses `spawn(commandName, args, { cwd, shell: false, stdio: ['ignore','pipe','pipe'] })`; Windows invokes `${commandName}.cmd` through `shell: true` with the same `cwd` and no project path in command text; output streams are collected; spawn errors reject.

- [ ] **Step 2: Run `npm test -- --test-name-pattern="process"` from `tools/npm-dep-upgrade-plan/`.** Expect the import to fail because `src/process.js` does not exist.

- [ ] **Step 3: Implement `runProcess` in `src/process.js`.** Collect stdout/stderr and resolve the close code; reject startup errors. Keep `cwd` out of the Windows shell command.

- [ ] **Step 4: Run the focused process tests.** Expect Unix, Windows, output collection, and spawn-error cases to pass.

- [ ] **Step 5: Commit.** Stage `src/process.js` and `test/process.test.js`; commit `feat: add portable subprocess runner`.

### Task 3: Consume and validate npm-dep-audit JSON

**Files:** Create `tools/npm-dep-upgrade-plan/src/audit.js` and `test/audit.test.js`.

**Interfaces:**

- `runNpmDepAudit(projectRoot: string, spawnImpl = spawn, platform = process.platform) -> Promise<{ schemaVersion: 2, auditedAt: string, rows: AuditRow[] }>`.
- `AuditRow` is `{ package, version, severity, advisories, requirements }`. Each advisory has `{ id, title, url, severity, range }`; `id` may be a string or number, `severity` is one of `info|low|moderate|high|critical`, and the other fields are strings. Each requirement is `{ declaredRequirement, directDependents }`; each dependent has string fields `name`, `version`, `location`, `targetLocation`, `type`, and `requestedName`.

- [ ] **Step 1: Write failing tests in `test/audit.test.js`.** Assert the exact Unix command `npm-dep-audit . --min-severity info --format json`, project-root `cwd`, and schema v2 parsing. Test Windows `.cmd` invocation. Validate `auditedAt`, row package/version/severity, advisory ID/title/URL/severity/range, requirement, and dependent fields. Include `location: ""` as a valid root link. Reject nonzero exit, missing command, invalid JSON, wrong schema version, malformed row, invalid advisory range, empty requirement/link collections, or malformed link.

- [ ] **Step 2: Run the focused audit tests.** Expect the import to fail because `src/audit.js` does not exist.

- [ ] **Step 3: Implement `runNpmDepAudit` in `src/audit.js`.** Call `runProcess('npm-dep-audit', ['.', '--min-severity', 'info', '--format', 'json'], projectRoot, spawnImpl, platform)`. Require exit code 0, parse JSON, and validate the schema and field types before returning it. Wrap failures with an actionable `npm-dep-audit` context.

- [ ] **Step 4: Run `node --test test/audit.test.js`.** Expect valid v2 data to pass and every malformed or failed command case to reject.

- [ ] **Step 5: Commit.** Stage `src/audit.js` and `test/audit.test.js`; commit `feat: consume npm-dep-audit reports`.

### Task 4: Query stable versions and their registry release times

**Files:** Create `tools/npm-dep-upgrade-plan/src/registry.js` and `test/registry.test.js`.

**Interfaces:**

- `fetchStableVersions(projectRoot: string, packageName: string, spawnImpl = spawn, platform = process.platform) -> Promise<string[]>`; the result is unique, valid stable semantic versions sorted ascending by semver.
- `fetchReleaseTimes(projectRoot: string, packageName: string, spawnImpl = spawn, platform = process.platform) -> Promise<Map<string,string>>`; stable-version keys with valid ISO timestamps are normalized to UTC ISO strings.

- [ ] **Step 1: Write failing tests in `test/registry.test.js`.** Assert `npm view <package> versions --json` and `npm view <package> time --json` run in the project directory on Unix and through `${command}.cmd` on Windows. Cover version normalization, scoped names, package-name rejection before spawning, invalid registry data, valid and invalid release timestamps, nonzero exit, and missing npm.

- [ ] **Step 2: Run the focused registry tests.** Expect the import to fail because `src/registry.js` does not exist.

- [ ] **Step 3: Implement the registry adapters in `src/registry.js`.** Validate npm package names before constructing a Windows shell command. Parse and normalize strict stable versions from the `versions` field. Read the `time` field into a map keyed by stable version; ignore missing or invalid timestamps so the report can emit null for those versions.

- [ ] **Step 4: Run `node --test test/registry.test.js`.** Expect all response-shape, filtering, ordering, and platform cases to pass.

- [ ] **Step 5: Commit.** Stage `src/registry.js` and `test/registry.test.js`; commit `feat: query stable npm package versions`.

### Task 5: Evaluate ordered remediation strategies per target location

**Files:** Create `tools/npm-dep-upgrade-plan/src/strategies.js`, `src/evaluate.js`, and `test/strategies.test.js`.

**Interfaces:**

- `findMinimumSafeVersion(row: AuditRow, stableVersions: string[]) -> string|null`; its result is independent of target requirements and is always newer than the installed version.
- `updateWithinDeclaredRange(row: AuditRow, declaredRequirements: string[], stableVersions: string[]) -> Strategy|null`; an eligible result is `{ id, targetPackage, currentVersion, targetVersion }`.
- `evaluateFindings(rows: AuditRow[], versionsByPackage: Map<string,{versions:string[],releaseTimes:Map<string,string>}>, strategies = orderedStrategies) -> EvaluatedRow[]` emits one row per target location with `status` and a nullable selected `strategy`.
- `orderedStrategies` contains `{ id, label, order, evaluate(row, declaredRequirements, stableVersions) }`, sorted by ascending numeric `order`; select the first eligible result.

- [ ] **Step 1: Write failing tests in `test/strategies.test.js`.** Test that package-level minimum-safe selection is newer than installed and outside every advisory range. Test per-location eligibility with multiple requirements, including a safe package-level version that a location cannot use, locations that share a package/version, future strategies that apply when `minimumSafeVersion` is null, supported ranges and npm aliases, and first-eligible strategy ordering.

- [ ] **Step 2: Run the focused strategy tests.** Expect the imports to fail because `strategies.js` and `evaluate.js` do not exist.

- [ ] **Step 3: Implement `findMinimumSafeVersion`, `updateWithinDeclaredRange`, and `orderedStrategies` in `src/strategies.js`.** Parse standard semver ranges and aliases of the form `npm:<audited-package>@<range>`. Find the lowest newer stable candidate outside all advisory ranges, then find the lowest safe version satisfying all requirements at the target location.

- [ ] **Step 4: Implement `evaluateFindings` in `src/evaluate.js`.** Group requirements by `targetLocation`, compute package/version safe release fields, and select the first eligible strategy for each location. Keep distinct target locations as separate rows.

- [ ] **Step 5: Run `node --test test/strategies.test.js`.** Expect all eligibility, reason, alias, multi-advisory, and link-preservation assertions to pass.

- [ ] **Step 6: Commit.** Stage `src/strategies.js`, `src/evaluate.js`, and `test/strategies.test.js`; commit `feat: evaluate package bump strategies`.

### Task 6: Render deterministic Markdown and JSON reports

**Files:** Create `tools/npm-dep-upgrade-plan/src/report.js` and `test/report.test.js`.

**Interfaces:**

- `sortFindings(rows: EvaluatedRow[]) -> EvaluatedRow[]`, ordered by severity, package, installed version, and target location.
- `renderMarkdown(rows: EvaluatedRow[]) -> string`.
- `renderJson(rows: EvaluatedRow[], auditedAt: string) -> string`.

- [ ] **Step 1: Write failing tests in `test/report.test.js`.** Assert severity order and target-location ordering. Markdown emits one row per composite key, labels severity **Highest severity** with `npm-dep-audit` styling, and shows minimum safe release data, status, and strategy. Parse JSON and assert schema version 2, `auditedAt`, the flattened row fields, null strategies for ineligible rows, and empty `rows`.

- [ ] **Step 2: Run the focused report tests.** Expect the import to fail because `src/report.js` does not exist.

- [ ] **Step 3: Implement sorting and renderers in `src/report.js`.** Emit one row per target location, render highest-severity styling, and serialize schema version 2 without repeating advisories or requirements.

- [ ] **Step 4: Run `node --test test/report.test.js`.** Expect deterministic ordering, Markdown, JSON, escaping, and empty-report assertions to pass.

- [ ] **Step 5: Commit.** Stage `src/report.js` and `test/report.test.js`; commit `feat: render upgrade plan reports`.

### Task 7: Integrate the CLI, executable, and documentation

**Files:** Create `tools/npm-dep-upgrade-plan/src/cli.js`, `bin/npm-dep-upgrade-plan.js`, `test/cli.test.js`, and `README.md`; modify `tools/npm-dep-upgrade-plan/package.json`, `package-lock.json`, and repository `README.md`.

**Interfaces:**

- `main(argv: string[], io = process, deps = defaults) -> Promise<number>` where defaults provide `runNpmDepAudit(projectRoot)`, `fetchStableVersions(projectRoot, packageName)`, `fetchReleaseTimes(projectRoot, packageName)`, and the two renderers.
- The bin sets `process.exitCode = await main(process.argv.slice(2))`.

- [ ] **Step 1: Write failing orchestration tests in `test/cli.test.js`.** Cover help without subprocess calls; default current directory and Markdown; explicit project and JSON; audit request once; one registry request per distinct package name and none for an empty report; evaluation and severity ordering; successful exit with ineligible links; and audit or later registry failure leaving stdout empty with an actionable stderr message.

- [ ] **Step 2: Run the focused CLI tests.** Expect failures because `src/cli.js` and the bin do not exist.

- [ ] **Step 3: Implement `main` in `src/cli.js` and the bin.** Parse arguments, request audit JSON, fetch versions and release times for unique package names, evaluate and render only after all queries succeed, write stdout exactly once, and return 0. On errors, write `npm-dep-upgrade-plan: <message>` to stderr and return 1. Add the bin mapping to `package.json` and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.

- [ ] **Step 4: Add executable-level tests with fake commands.** Place all generated project and command fixtures under `/home/maw/src/nrc/npm-dep-flow-impl/tmp`; do not use a system temp directory. Put fake `npm-dep-audit` and `npm` commands on a controlled `PATH`. Assert default Markdown and `--format json`, separate rows for target locations, the package-level minimum safe version and release time, nullable strategies, no partial stdout on registry failure, and unchanged target `package.json`/`package-lock.json` bytes after each successful run.

- [ ] **Step 5: Write `tools/npm-dep-upgrade-plan/README.md`.** Document installation, the prerequisite standalone `npm-dep-audit` command and its `npm-dep-paths` setup, command examples, registry lookup behavior, stable-version and per-target-location semantics, Markdown default, JSON schema v2, and errors. Update the root README tool index to link the new CLI and describe its read-only purpose.

- [ ] **Step 6: Run final verification from `tools/npm-dep-upgrade-plan/`.** Run `npm ci --ignore-scripts`, `npm test`, and `node bin/npm-dep-upgrade-plan.js --help`. Run `git diff --check` from the repository root. Expect the suite and help command to pass, no whitespace errors, and no changes under `tools/npm-dep-audit/`.

- [ ] **Step 7: Commit.** Stage only the new tool files and root README; commit `feat: add npm dependency upgrade planner`.
