# Repository guide for agents

## Repository layout

- This repository contains small command-line tools for maintaining Node.js project dependencies. The root contains shared documentation; it is not an npm package or workspace.
- Each `tools/<name>/` directory is an independent Node.js project with its own manifest, lockfile, executable, source, tests, and README. Keep CLI dependencies and tool-specific npm commands within the relevant tool directory.
- `dev-tooling/` is a separate private development package with the shared ESLint dependencies, lockfile, configuration, and commands. Keep the root a non-package and do not introduce npm workspaces.
- Tools should exchange data through documented command-line output, including versioned JSON, rather than importing another tool's private source files.
- Start with the [repository README](README.md) for all five tool guides and design documents.

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
- Use Node.js 24 for development and CI; shared lint tooling requires `^20.19.0 || ^22.13.0 || >=24` independently of the CLI runtime minimum.
- From the repository root, install lint dependencies with `npm --prefix dev-tooling ci --ignore-scripts`, check with `npm --prefix dev-tooling run lint`, and apply fixes with `npm --prefix dev-tooling run lint:fix`. The same npm commands without `--prefix dev-tooling` work inside `dev-tooling/`.
- Run shared lint for every future JavaScript change, including executables, tests, and test helpers, and run affected tool tests after fixes. All pull requests must pass the GitHub Actions `lint` job with zero warnings and the tool test checks before merging.
- Use the single shared `dev-tooling/eslint.config.mjs` with unchanged `@eslint/js` and `@stylistic/eslint-plugin` recommended configurations and upstream style defaults. It also enables a fixed set of additional readability rules in its own `rules` block; add a rule there only if neither recommended configuration already sets it, and never change the severity or options of a recommended rule. Do not add personal rule overrides, rule-disable comments to bypass findings, or Prettier. Node.js globals and ESM/CommonJS file scopes belong in this config; generated `node_modules`, `tmp`, `coverage`, `dist`, and `.cache` directories are excluded.
- Keep correctness changes separate from mechanical formatting commits and explain any behavioral corrections. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup and integration checks.
- Whenever CLI help text changes, run the affected tool with `--help` and inspect the rendered output. Keep argument and option descriptions aligned to one common column, with at least two spaces after the longest label; widen the padding for all rows when adding a longer flag or placeholder. Check alignment alongside flag coverage before committing.
- Preserve each tool's documented CLI and JSON interface: schema version 3 for upgrade-plan/upgrade, version 2 for audit/paths/versions. Human-readable reports use Markdown with one tool-name H1; an empty report has a message without a table. Paths retains `--format text` as an alias for `markdown`.
- Completed reports exit 0 even when findings exist or all strategies are ineligible. Errors exit 1 with stderr diagnostics and no partial report on stdout.
- The four analysis tools must not install dependencies, run lifecycle scripts, or modify target project files. `npm-dep-upgrade` is an explicitly invoked mutator: it may install with scripts disabled, edit the selected project's dependency files, and commit its verified changes under its documented guards. Analysis caches live outside the target project by default.
- Keep npm and sibling-command subprocess launching portable: Windows uses `.cmd` through a shell; Unix-like systems spawn commands directly. Test both paths when changing subprocess behavior.

## Working on npm-dep-audit

- Entry point: `bin/npm-dep-audit.js`. `src/cli.js` coordinates project loading, npm context, caching, row construction, and rendering; tests live in `test/`.
- Reads the target manifest and lockfile, invokes `npm audit --json`, and uses the separately installed `npm-dep-paths` CLI on `PATH` for dependency requirements. Preserve raw/enriched cache validation, original advisory expiry, and no-cache propagation to paths.
- Set `NPM_DEP_PATHS_INTEGRATION=1` to test the real paths CLI boundary. See the [audit guide](tools/npm-dep-audit/README.md).

## Working on npm-dep-paths

- Entry point: `bin/npm-dep-paths.js`. `src/cli.js` coordinates selector validation, lockfile graph construction, summaries, upstream selection, and rendering.
- Needs no npm subprocess, registry, sibling CLI, or target `node_modules` at runtime. Structured result caching is content-based; validate project inputs before cache hits and preserve `--no-cache`. Preserve graph completeness, alias identity, installation counts, and the unfiltered summary when upstream filters are used.
- `npm test` includes the real executable checks with no integration switch. See the [paths guide](tools/npm-dep-paths/README.md).

## Working on npm-dep-upgrade-plan

- Entry point: `bin/npm-dep-upgrade-plan.js`. `src/cli.js` coordinates the audit adapter, registry lookups, strategy evaluation, and rendering.
- Uses the separately installed audit CLI (which uses paths) and versions CLI for cached stable registry catalogs. Preserve per-target-location identity, compatible-consumer actions, and none/partial/complete resolution. Verify new splits and multi-action sets with read-only resolution. Planner caches must include effective npm configuration and sibling versions/locations, retain upstream advisory expiry, and forward TTL/bypass controls to audit and versions, and preserve the earliest audit/catalog source freshness.
- Strategy `upgrade-angular-toolchain` runs third, only for branches the other two strategies left uncovered; it bumps exact-pinned `@angular/cli`/`@angular/build` as one same-major unit, with no release-age filter in the planner.
- Set `NPM_DEP_AUDIT_INTEGRATION=1` to test the real audit CLI boundary with fixture npm/paths responses. See the [planner guide](tools/npm-dep-upgrade-plan/README.md).

For test scratch directories, `NPM_DEP_FLOW_TEST_TMPDIR` overrides checkout-local audit/planner integration and planner executable scratch roots; `NPM_DEP_PATHS_TEST_TMPDIR` overrides paths fixture roots. Other temporary fixtures follow the operating system temporary directory (`TMPDIR` on Unix-like systems).

## Working on npm-dep-upgrade

- Entry point: `bin/npm-dep-upgrade.js`; independent package with public planner/audit/paths subprocess boundaries. Never import sibling private modules.
- CLI: `npm-dep-upgrade [project] <id-or-prefix> [--package <name>] [--format markdown|json]`. The project defaults to the caller's current directory. One selector identifies one current installation by SHA-256 prefix, optionally filtered by exact package name. Only update-within-declared-range is supported.
- Execution order is toolchain (`upgrade-angular-toolchain`: `nx migrate` in the real clean project, own commit, allowlisted `package.json` changes, 7-day age on `@angular/cli`), then parent, then within-range.
- Preserve direct ^/~ operators. Use reversible scoped overrides for transitive targets. Execute every planned action for the selected finding, preserving incompatible incoming pins. Verify consumer identities through splits/relocations; never leave an unnecessary override or upgrade unrelated target copies. Verify all snapshots before committing and create one commit per actual upgrade, preserving any committed prefix on a later commit failure. Supporting closure changes are permitted after validation.
- All installs must ignore scripts and enforce at least seven days of release age. Fresh candidate-version and final advisory checks are mandatory.
- Require clean tracked dependency files and an empty repository-wide index; preserve unrelated unstaged work. Stage only verified dependency files and use the documented default or explicitly configured dependency commit subject. Never reset HEAD or overwrite concurrent work during recovery.
- Default E2E runtime is npm12.1.0 on Node24.21.0; compatibility runtime is npm11.10.0. Provision them outside isolated test cases and pass the test-only CLI entry variables documented in the tool README. Run `npm test` and `npm run test:e2e`; coverage and matrix details are in `test/e2e/COVERAGE.md`.

## Working on npm-dep-versions

- Entry point: `bin/npm-dep-versions.js`; independent package with public schema version 2 JSON and Markdown reports.
- Fetch exactly `npm view <package> versions time --json` on a catalog miss/bypass; never derive membership from time keys or remove versions with unknown dates.
- Stable-only default, `--all`, `--major`, and `--range` filter the complete cached catalog. `--project` selects npm configuration context and requires no manifest or lockfile.
- Catalog identity includes canonical context, package, npm/tool versions, and a digest of effective configuration excluding moving `before`; never store configuration secrets. Preserve original fetchedAt and atomic, nonfatal cache behavior.
- `npm test` includes executable tests. Set `NPM_DEP_UPGRADE_E2E_NPM_CLI` and `NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI` to pinned npm 12.1.0 / 11.10.0 entries to exercise real npm metadata envelopes against a local registry. `NPM_DEP_VERSIONS_REQUIRE_RUNTIMES=1` makes absent required runtime entries an error in CI (npm12 on Windows, both on Unix).
