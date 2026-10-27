# Contributing

## Development setup and linting

The repository root is not an npm package or workspace. Each CLI under `tools/` remains an independent package. Shared lint dependencies and their lockfile live in the private `dev-tooling/` package; do not add them to the CLI packages or introduce npm workspaces.

Use Node.js 24 for development, matching CI. The lint tooling supports Node.js `^20.19.0 || ^22.13.0 || >=24`. The four analysis CLIs support Node.js 20 or newer; `npm-dep-upgrade` supports Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`.

From the repository root:

```sh
npm --prefix dev-tooling ci --ignore-scripts
npm --prefix dev-tooling run lint
npm --prefix dev-tooling run lint:fix
```

Alternatively, run `npm ci --ignore-scripts`, `npm run lint`, or `npm run lint:fix` inside `dev-tooling/`. After automatic fixes, resolve remaining findings and rerun lint and the affected tools' tests.

The shared flat configuration is `dev-tooling/eslint.config.mjs`. The commands supply it explicitly and lint source, executables, tests, and test helpers across `npm-dep-paths`, `npm-dep-audit`, `npm-dep-upgrade-plan`, `npm-dep-versions`, and `npm-dep-upgrade`, plus development-tooling JavaScript. It configures Node.js globals, ESM for `.js`/`.mjs`, and CommonJS for `.cjs`. Generated `node_modules`, `tmp`, `coverage`, `dist`, and `.cache` directories are excluded.

Use the unchanged `@eslint/js` recommended and `@stylistic/eslint-plugin` recommended configurations. Keep their upstream style defaults; do not add personal rule overrides, rule-disable comments to bypass findings, or Prettier.

On top of those two sets, the shared configuration enables additional readability rules in a dedicated `rules` block. Add a rule there only if neither recommended configuration already sets it, and never change the severity or options of a recommended rule. The additional rules are:

- Simpler control flow: `no-else-return`, `no-lonely-if`, `no-negated-condition`, `no-nested-ternary`, `no-unneeded-ternary`, `no-useless-return`, `default-case-last`.
- Clearer expressions and assignments: `eqeqeq` (comparisons with `null` are exempt, so `== null` still checks `null` and `undefined`), `yoda`, `dot-notation`, `no-multi-assign`, `no-return-assign`, `no-useless-concat`, `no-useless-rename`, `prefer-exponentiation-operator`, `prefer-regex-literals`.
- Blank-line layout: `@stylistic/padding-line-between-statements` requires a blank line after the last `import` and before and after every function declaration. Consecutive imports and one-line `const` helpers that are not function declarations are exempt from the extra padding; `lint:fix` inserts the lines.
- Modern, predictable declarations: `no-var`, `prefer-const`, `object-shorthand`, `prefer-arrow-callback`, `prefer-object-spread`, `default-param-last`, `no-use-before-define` (hoisted function declarations are exempt).

Fix a finding in the code instead of disabling its rule; for example, replace a nested ternary with `if`/`else`, a lookup object, or a helper function. Keep the pinned versions and lockfile in sync when updating lint dependencies.

Every future JavaScript change must pass shared lint with zero warnings. Pull requests must pass the GitHub Actions `lint` job and the tool test checks before merging. The lint workflow runs on every pull request targeting `main` and every push to `main`, including changes only to shared configuration or documentation.

## Tests and compatibility

From each affected `tools/<name>/` directory, run `npm ci --ignore-scripts` and `npm test`. There is no root-level test command. Before submitting changes across multiple tools, run each affected suite and its documented integration checks:

- Paths includes real executable checks in `npm test` without an integration switch.
- Audit: install this checkout's paths CLI separately on `PATH`, then run `NPM_DEP_PATHS_INTEGRATION=1 npm test` in `tools/npm-dep-audit/`.
- Versions: run `npm test`; configure the pinned npm runtime entry variables described in its README to include registry compatibility checks.
- Upgrade planner: install this checkout's audit and versions CLIs separately on `PATH`, then run `NPM_DEP_AUDIT_INTEGRATION=1 npm test` in `tools/npm-dep-upgrade-plan/`. This integration uses fixture npm/paths responses and needs no live registry.
- Upgrade mutator: run `npm test` and `npm run test:e2e` in `tools/npm-dep-upgrade/`. Follow its README to provision the pinned npm 12.1.0 and npm 11.10.0 test runtimes outside the isolated fixtures; the E2E suite runs the real tool CLIs against a fake registry.

The environment assignment examples use POSIX shell syntax. In PowerShell, set the corresponding `$env:NPM_DEP_PATHS_INTEGRATION` or `$env:NPM_DEP_AUDIT_INTEGRATION` to `'1'` before running `npm test`. See each tool's README for installation and integration details.

Preserve documented CLI behavior, exit codes, Markdown output, and JSON contracts (schema 3 for upgrade-plan/upgrade; schema 2 for audit/paths/versions). Keep necessary correctness changes separate from mechanical formatting commits and explain them in the pull request. Follow the versioning and commit sequencing policy in [AGENTS.md](AGENTS.md).

## Commit messages and pull request titles

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for every commit message and pull request title.

Use this header format:

```text
<type>[optional scope][!]: <description>
```

Choose a type that describes the change. Common types include `feat` for a new feature, `fix` for a bug fix, `docs` for documentation, `test` for tests, `refactor` for a behavior-preserving code change, `ci` for CI changes, `build` for build or dependency changes, and `chore` for other maintenance. A scope is optional; use it to identify the affected tool or area, such as `audit`, `paths`, `upgrade-plan`, or `ci`.

Examples:

```text
feat(audit): add JSON report output
fix(paths): handle a missing lockfile
docs: explain local setup
```

For a breaking change, put `!` after the type or scope. Commit messages may also describe the change in a `BREAKING CHANGE:` footer:

```text
feat(audit)!: change the report schema

BREAKING CHANGE: consumers must read the new report field.
```

Make each commit message describe that commit. Make the pull request title describe the overall change in the pull request, using the same header format. For example:

```text
feat(audit): add JSON report output
```
