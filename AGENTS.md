# Repository guide for agents

## Repository layout

- This repository contains small command-line tools for maintaining Node.js project dependencies. The root contains shared documentation; it is not an npm package or workspace.
- Each `tools/<name>/` directory is an independent Node.js project with its own manifest, lockfile, executable, source, tests, and README. Keep tool dependencies and npm commands within the relevant tool directory.
- Tools should exchange data through documented command-line output, including versioned JSON, rather than importing another tool's private source files.
- Start with the [repository README](README.md) for all three tool guides and design documents.

## Versioning

- Every plan that changes a tool must include a version bump for each affected tool package.
- Use a patch bump for bug fixes or corrections to existing behavior. Use a minor bump for new features or capabilities.
- Keep the `version` in each affected `package.json` and its `package-lock.json` root metadata in sync.
- Bump each affected tool only once per pull request, relative to the PR's base version. Put all tool version bumps together in the final planned commit, after implementation, documentation, and verification; earlier planned commits must not bump versions.
- After a PR is created, follow-up fixes may be committed on top of the version-bump commit. Keep the intended release version unchanged unless the fixes require a different release version, such as upgrading a planned patch release to a minor release. In that case, update the version and lockfile metadata to the revised release version; do not increment the already planned version merely because another fix commit was added.

## Commit messages and pull request titles

- Follow the commit message and pull request title rules in [CONTRIBUTING.md](CONTRIBUTING.md).
- Every commit message and pull request title you create must use the Conventional Commits header format described there. Choose a type and optional scope that match the change, and mark breaking changes as specified.
- Before presenting a commit or pull request for review, check that its message or title follows the format.

## Review and commits

- In the plan step, list the intended commits and their contents before implementation begins.
- Keep unrelated changes in separate commits.
- Never request a review while the working tree has uncommitted changes. Commit the changes on a local branch or worktree before requesting review.

## Shared development and output contracts

- Use Node.js 20 or newer. From the relevant `tools/<name>/` directory, run `npm ci --ignore-scripts` and `npm test`. There is no root-level `npm test`.
- Preserve each tool's documented CLI and schema version 2 JSON interface. Human-readable reports use Markdown with one tool-name H1; an empty report has a message without a table. Paths retains `--format text` as an alias for `markdown`.
- Completed reports exit 0 even when findings exist or all strategies are ineligible. Errors exit 1 with stderr diagnostics and no partial report on stdout.
- Tools must not install dependencies, run lifecycle scripts, or modify target project files. Audit's cache lives outside the target project.
- Keep npm and sibling-command subprocess launching portable: Windows uses `.cmd` through a shell; Unix-like systems spawn commands directly. Test both paths when changing subprocess behavior.

## Working on npm-dep-audit

- Entry point: `bin/npm-dep-audit.js`. `src/cli.js` coordinates project loading, npm context, caching, row construction, and rendering; tests live in `test/`.
- Reads the target manifest and lockfile, invokes `npm audit --json`, and uses the separately installed `npm-dep-paths` CLI on `PATH` for dependency requirements. Preserve cache validation and no-cache behavior.
- Set `NPM_DEP_PATHS_INTEGRATION=1` to test the real paths CLI boundary. See the [audit guide](tools/npm-dep-audit/README.md).

## Working on npm-dep-paths

- Entry point: `bin/npm-dep-paths.js`. `src/cli.js` coordinates selector validation, lockfile graph construction, summaries, upstream selection, and rendering.
- Needs no npm subprocess, registry, sibling CLI, or target `node_modules` at runtime. Preserve graph completeness, alias identity, installation counts, and the unfiltered summary when upstream filters are used.
- `npm test` includes the real executable checks with no integration switch. See the [paths guide](tools/npm-dep-paths/README.md).

## Working on npm-dep-upgrade-plan

- Entry point: `bin/npm-dep-upgrade-plan.js`. `src/cli.js` coordinates the audit adapter, registry lookups, strategy evaluation, and rendering.
- Uses the separately installed audit CLI (which uses paths) and npm registry queries. Preserve per-target-location eligibility and ordered strategy selection.
- Set `NPM_DEP_AUDIT_INTEGRATION=1` to test the real audit CLI boundary with fixture npm/paths responses. See the [planner guide](tools/npm-dep-upgrade-plan/README.md).

For test scratch directories, `NPM_DEP_FLOW_TEST_TMPDIR` overrides checkout-local audit/planner integration and planner executable scratch roots; `NPM_DEP_PATHS_TEST_TMPDIR` overrides paths fixture roots. Other temporary fixtures follow the operating system temporary directory (`TMPDIR` on Unix-like systems).
