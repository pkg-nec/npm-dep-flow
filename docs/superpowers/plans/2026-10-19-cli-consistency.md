# CLI Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the 12 agreed consistency fixes across npm-dep-audit, npm-dep-paths, and npm-dep-upgrade-plan.

**Architecture:** Keep three independent tool packages and their existing JSON interfaces. Align human-readable output, documentation, diagnostics, and platform verification within each package; do not introduce a shared runtime package or imports between tools. Retain tool-specific selectors, options, report semantics, and network requirements.

**Tech Stack:** Node.js >=20, ES modules, node:test, npm lockfiles, Markdown, GitHub Actions.

**Spec:** The approved 12-item proposal in this chat (2026-10-19); the exact implementation decisions are recorded below. This is bounded work on existing flows, so there is no separate architectural spec.

## Global Constraints

- Main checkout: `/home/maw/src/nrc/npm-dep-flow-impl/npm-dep-flow`.
- All temporary files: `/home/maw/src/nrc/npm-dep-flow-impl/tmp`.
- Any implementation worktree: `/home/maw/src/nrc/npm-dep-flow-impl/worktrees/<branch-directory>`; use the using-git-worktrees skill at execution time.
- Each package remains independent; run npm commands in its tool directory. No new dependencies.
- Keep JSON schemaVersion 2 and all existing JSON fields, ordering, row identities, and empty-query/error semantics.
- Completed reports exit 0; failures exit 1, emit diagnostics on stderr, and emit no partial report on stdout.
- Human-readable output starts with exactly one `# <tool-name>` heading and ends with one newline. Empty reports contain the heading, a blank line, and the existing tool-specific message, without a table.
- Paths uses `markdown` as its default/documented human-readable format; `text` remains an accepted alias producing identical output.
- Preserve audit severity styling, generated advisory links, alias identity, installation counts, and paths' complete unfiltered summary when upstream filters are used.
- Never install dependencies, run lifecycle scripts, or change files in a target project at tool runtime.

## Review Focus

- Paths reports with several installed versions: one H1, one H2 per result, no duplicate title when upstream detail is appended (Task 1).
- User values with Markdown, HTML, or control characters: literal display without broken rows/headings or terminal controls; JSON values unchanged (Task 2).
- Upstream values containing backtick runs: fenced text remains inside its code block; cycles and shared nodes retain references (Task 1).
- Failed child commands with empty stderr or malformed JSON: useful command context, no accidental child stdout dump, no partial report (Task 3).
- Windows and paths containing spaces: paths' real executable suite and existing subprocess integration tests remain usable (Tasks 3 and 5).

## File Map

Paths below are repository-relative. At execution time resolve them against the selected implementation checkout.

| Files | Responsibility |
| --- | --- |
| `tools/npm-dep-audit/src/render.js`, `test/render.test.js` | Audit title, empty report, literal Markdown values |
| `tools/npm-dep-paths/src/report.js`, `test/report.test.js` | Paths title, result headings, literal Markdown values |
| `tools/npm-dep-paths/src/cli.js`, `test/cli.test.js` | Format alias/default, upstream code-block composition |
| `tools/npm-dep-upgrade-plan/src/report.js`, `test/report.test.js` | Planner literal Markdown values; existing title/empty behavior regression |
| `tools/npm-dep-upgrade-plan/src/audit.js`, `test/audit.test.js`, `test/cli.test.js` | Failed audit diagnostics and CLI failure contract |
| Three tool `package.json` and `package-lock.json` pairs | Version increments and matching root metadata |
| Root `README.md`, `AGENTS.md`, three tool READMEs | Navigation, common documentation structure, working guidance |
| Three existing `docs/superpowers/specs/*-design.md` files | Current output examples and terminology |
| `.github/workflows/npm-dep-paths.yml` | Linux and Windows test matrix |
| Existing tests with checkout-local scratch paths | Optional external scratch-root override, preserving portable defaults |

## Intended Commits

1. `feat(paths): align human-readable report conventions` — titles/empty states across tools, paths format alias and upstream fences; paths version 0.2.1 -> 0.3.0, audit 0.2.0 -> 0.2.1. Include related tests and affected package metadata.
2. `fix: render report values consistently as literal Markdown` — escaping policy and renderer regressions; planner version 0.2.0 -> 0.2.1. Audit/paths are already bumped for this release series.
3. `fix(upgrade-plan): preserve failed audit diagnostics` — diagnostics, failure regressions, and configurable scratch roots for tests run during this work. Planner's release bump is already included in commit 2.
4. `docs: align tool guides and design references` — README structure/examples, all design links, agent guidance, current design examples.
5. `ci(paths): test on Linux and Windows` — paths OS matrix.

The resulting versions are audit 0.2.1, paths 0.3.0, planner 0.2.1. Paths receives a minor increment for the new accepted format name. Keep each manifest version, lockfile top-level version, and lockfile `packages[""].version` identical; do not refresh unrelated dependency resolutions. Commit prefixes may be refined to fit the final scope, preserving Conventional Commits.

## Task 1: Align report structure and paths format selection

**Files:** Audit renderer/tests; paths renderer/CLI/tests; planner report tests; audit and paths manifests/lockfiles.

**Interfaces:** Preserve `renderMarkdown(rows) -> string`, `renderSummaryText(project, results) -> string`, `renderUpstreamText(project, result, upstream, from) -> string`, and `main(argv, io, deps) -> Promise<number>`. Keep the existing internal `Text` function names to limit churn. Paths' CLI composes the summary with an optional fenced upstream section; `renderUpstreamText` continues to return raw text.

- [ ] Add renderer assertions for populated reports starting with the correct H1 and empty reports equaling `# npm-dep-audit\n\nNo matching direct advisories.\n`, `# npm-dep-paths\n\nNo matching installed packages.\n`, and the existing planner empty string. Add two-result paths assertions for exactly one H1 and two `## package@version` sections.
- [ ] Add paths CLI cases asserting default output equals `--format markdown` and `--format text`, for normal, overview, and focused queries; JSON output remains unchanged. Assert upstream text is fenced once after the summary and a value containing three backticks cannot close the fence. Pick a fence longer than any backtick run in the rendered text.
- [ ] Run `node --test test/render.test.js` in audit, `node --test test/report.test.js test/cli.test.js` in paths, and `node --test test/report.test.js` in planner. Confirm new assertions fail for the intended differences before implementation.
- [ ] Add audit/paths H1s; remove audit's empty table; change paths result headings to H2. Accept `markdown`, `text`, and `json` in paths, default to `markdown`, and update its help. Fence only the upstream detail in CLI composition using a `text` code fence of safe length.
- [ ] Apply audit/paths version increments, then rerun the focused commands. Check invalid formats still exit 1 with empty stdout, all aliases produce identical output, and populated tables retain their existing contents.
- [ ] Commit the task using intended commit 1.

## Task 2: Align literal Markdown rendering

**Files:** All three renderer files and their existing renderer tests; planner manifest/lockfile.

**Interfaces:** Existing rendering exports remain unchanged. Implement local helpers in each tool; do not export a shared helper or import another tool's implementation.

**Policy:** For user-controlled text in Markdown cells and headings, convert LF/CR/tab into visible `\n`/`\r`/`\t`; convert other C0 controls and DEL into visible `\xNN`; encode `&`, `<`, and `>`; escape backslashes, pipes, square brackets, asterisks, underscores, and backticks. Preserve Unicode. Apply escaping exactly once per raw value. Generated links, line breaks, severity HTML, and table syntax remain deliberate markup. Inside fenced upstream text, retain raw Markdown characters while keeping control characters visible. JSON preserves original values.

- [ ] Add regressions in each renderer suite using values containing `a|b`, `[x]`, `*x*`, `_x_`, a backtick, a backslash, `<tag>&`, LF/CR/tab, ESC, DEL, and Unicode. Assert escaped literal values, a stable number of table rows, no raw controls, and unchanged JSON strings. Include paths' package heading and audit advisory title/alias labels.
- [ ] Run each affected renderer suite and confirm the new assertions fail before changing helpers.
- [ ] Update the existing local escaping helpers and their call sites to implement the policy without double escaping. Keep paths' raw dependent labels available until the Markdown boundary.
- [ ] Apply planner's patch increment. Rerun renderer tests; retain tests proving generated advisory links, severity markup, installation counts, null values, and JSON identities remain correct.
- [ ] Commit the task using intended commit 2.

## Task 3: Preserve failed audit diagnostics

**Files:** Planner `src/audit.js`, `test/audit.test.js`, `test/cli.test.js`; planner `test/audit.integration.test.js`; audit `test/dep-paths.integration.test.js`.

**Interfaces:** Preserve `runNpmDepAudit(projectRoot, spawnImpl, platform) -> Promise<report>` and the public CLI exit contract.

- [ ] Replace the existing test named `audit adapter rejects a nonzero command result without echoing stderr` with an explicit new expectation: a nonzero result includes `npm-dep-audit`, its exit code, and trimmed nonempty stderr. This intentionally supersedes the previous suppression rule approved in the consistency proposal. Add empty-stderr fallback coverage and keep invalid-JSON coverage that prohibits echoing child stdout.
- [ ] Add a planner CLI regression: when the audit adapter fails, return 1, leave stdout empty, and preserve the contextual diagnostic on stderr. Retain missing-command installation guidance and Unix/Windows launch assertions.
- [ ] Run `node --test test/audit.test.js` in planner and confirm the new diagnostic assertion fails before implementation. Run the new CLI failure regression with `node --test --test-name-pattern='<new regression name>' test/cli.test.js` so pre-existing executable tests do not create checkout-local scratch files before the override below exists.
- [ ] Append trimmed stderr to the existing failed-command message when present; retain the supported-project/PATH guidance as the fallback when it is empty. Never fall back to dumping stdout.
- [ ] Let the three tests that currently hardcode checkout-local scratch directories honor `NPM_DEP_FLOW_TEST_TMPDIR` as an optional base, preserving their existing defaults. This keeps local execution within the user's temporary-file constraint. Do not broaden this into a general test infrastructure rewrite.
- [ ] Rerun focused planner tests with the external scratch override, plus the audit-to-paths integration when its prerequisite CLI is available. Confirm no partial stdout on failure.
- [ ] Commit the task using intended commit 3.

## Task 4: Align documentation and agent guidance

**Files:** Root README/AGENTS, three tool READMEs, three existing design documents.

**Interfaces:** Document Tasks 1–3; the JSON schema and each tool's purpose remain distinct.

- [ ] Retain the root Design documents section and link all three existing designs with parallel labels. Replace audit-only “current tool” wording in AGENTS with the three-tool index.
- [ ] Move shared Node >=20, independent-package npm commands, exit/output contracts, and read-only requirements into shared agent guidance. Give each tool a short section identifying its entry point, orchestration, external CLI dependencies, and integration-test switch. Preserve versioning, commit/review, cache, and subprocess portability rules.
- [ ] Give each README these common sections: Requirements and installation; Usage; Human-readable report; JSON contract; Supported projects; Errors and exit codes; Development. Put eligibility under a planner-specific section and cache behavior under an audit-specific section; avoid empty counterpart sections.
- [ ] Include global installation and direct `node bin/<tool>.js` usage for each tool. State where installation commands start and the tool's actual prerequisites: paths uses lockfile data without npm at runtime; audit needs npm and paths; planner needs audit, transitively paths, and registry access. Do not instruct users to install all tools just to use paths.
- [ ] Add one small populated human-readable example and describe the empty report for each tool. Add a complete audit JSON example; retain and verify the paths/planner examples, schema versions, field names, and null/empty conventions.
- [ ] Document all tools' exact 0/1 exit behavior and no-partial-stdout rule, paths' `text` compatibility alias, and the planner's contextual failed-child diagnostic.
- [ ] Update existing designs to reflect headings, empty states, escaping, and paths' format/fenced detail. Replace paths' obsolete aligned-text example and remove its branch-specific paragraph. Preserve historical implementation plans.
- [ ] Manually check local link targets, code fences, installation directory transitions, and examples against fixture renderer/CLI outputs. Confirm no missing common sections and no claims that paths requires node_modules. Do not add tests that merely assert README wording.
- [ ] Commit the task using intended commit 4.

## Task 5: Complete paths platform coverage and final verification

**Files:** `.github/workflows/npm-dep-paths.yml`.

**Interfaces:** Existing `npm test` suite runs independently on each matrix OS; other workflows keep their current integration boundaries.

- [ ] Match the existing audit/planner pattern: `runs-on: ${{ matrix.os }}` with `os: [ubuntu-latest, windows-latest]`. Retain Node 24, pinned actions, restricted permissions, disabled credential persistence, and `npm ci --ignore-scripts`.
- [ ] Run the full paths suite locally, inspect the YAML against the working adjacent workflows, and commit using intended commit 5. A successful Linux run does not establish Windows success; record the Windows CI result once available.
- [ ] Run the final checks below once after all changes. Resolve actual failures, commit any fixes by scope, and record any checks that could not run. Do not claim integration or Windows success without evidence.

## Execution Setup and Final Checks

Before running tests, create the user-specified temporary base, export `TMPDIR=/home/maw/src/nrc/npm-dep-flow-impl/tmp`, `NPM_DEP_PATHS_TEST_TMPDIR` to that same base, and `NPM_DEP_FLOW_TEST_TMPDIR` to that same base. Route npm cache and any captured output there too. Before Task 3's overrides exist, use focused tests that do not create checkout-local scratch files; defer the planner executable/integration tests until the overrides are implemented.

- Run `npm ci --ignore-scripts` only in tool directories that need dependencies, with an npm cache under the specified temporary base.
- Run `npm test` separately in all three tool directories. There is no root npm package or root test command.
- Exercise the real audit-to-paths contract with `NPM_DEP_PATHS_INTEGRATION=1`, using an installed paths CLI on PATH.
- Exercise the real planner-to-audit contract with `NPM_DEP_AUDIT_INTEGRATION=1`, using an installed audit CLI on PATH. The existing planner integration mocks paths and npm; do not describe it as full three-tool end-to-end coverage.
- Avoid changing the user's global install during verification: install test CLIs under a prefix inside the specified temporary base and prepend its bin directory to PATH (or use existing correctly versioned commands). Keep integration-test JSON checks and failure behavior intact.
- Verify `--help` and `--version` for all three executables, including paths' documented format/default and each new version/location.
- Check package/lockfile version agreement and `git diff --check`; inspect final documentation links and output examples.
- Confirm Linux/Windows paths jobs through CI when a PR is created; do not create or merge a PR as part of merely writing this plan.
- Finish with a clean committed implementation branch before requesting code review, following AGENTS.md. Report completed checks, skipped integrations, and pending Windows CI distinctly.

## Coverage and Handoff

Proposal items 1–3 map to Task 1; item 11 to Task 2; item 10 to Task 3; items 4–9 to Task 4; item 12 to Task 5. Each review-focus condition is assigned above. No JSON migration or shared-package refactor is planned.

Review this plan before implementation and select native execution or subagent-driven execution. Native execution is recommended: the changes are small, connected through the same report/documentation conventions, and have focused existing test suites.
