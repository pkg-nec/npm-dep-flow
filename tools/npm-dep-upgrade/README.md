# npm-dep-upgrade

Upgrade one vulnerable npm installation selected by a fresh planner ID, verify it, and create one local Git commit.

## Setup

Use Git 2.36 or newer and Node.js 24.21.0 with npm 12.1.0 as the reference runtime. npm 11.10.0 is covered by the documented compatibility subset. The selected npm on `PATH` is used throughout; this tool never installs or changes npm itself. Other npm versions are not covered by this matrix.

Each tool is independently installed. Install `npm-dep-paths`, `npm-dep-audit`, and `npm-dep-upgrade-plan` and keep their commands on `PATH`, then install this tool from its directory:

```sh
npm ci --ignore-scripts
npm install --global . --ignore-scripts
```

## Usage

Run from the target npm project, including a project nested inside a Git repository:

```sh
cd '/path/to/my project'
npm-dep-upgrade-plan .
npm-dep-upgrade abc1234
npm-dep-upgrade <full-id> --package @scope/package --format json
npm-dep-upgrade --help
npm-dep-upgrade --version
```

The selector is a lowercase hexadecimal prefix of 7–64 characters. Planner JSON contains the full SHA-256 of `package + "__" + targetLocation`; Markdown shows seven characters. IDs identify package/location, independent of the installed version and absolute project path. A short prefix can collide. `--package` filters by exact package name before uniqueness checking; two locations of the same package may still need a longer prefix. Automation should use full IDs plus package names.

Each invocation reruns the planner and applies exactly one eligible `update-within-declared-range` row. There is no plan-file input, `--to`, parent upgrade, batch execution, or orchestration. A resolved ID usually disappears from the next report; repeating it returns target-not-found without another commit.

## Selection and application

The tool chooses the newest stable version that is newer than the installed version, at least the planner's minimum safe version, safe under fresh candidate-version advisories, within every original incoming requirement, and at least seven days old. It checks the chosen version's own release timestamp. Missing/invalid timestamps exclude a version; a valid older safe fallback is allowed. Effective stricter npm release-age and `before` cutoffs are preserved. A security service failure is an error. The planner's minimum timestamp alone does not establish candidate eligibility.

Direct dependencies in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` retain their section and literal `^` or `~` operator. For example, `~6.0.8` locked at 6.0.9 becomes `~6.0.12`. All compatible duplicate declarations are updated. Exact direct pins and unsupported declaration forms are outside this release's scope.

For transitive targets, temporary parent-version/ancestor overrides must be proven to affect only the selected installation. A directly declared parent uses `".": "$parent-name"` within its scoped rule. Existing unrelated override policy is preserved; conflicting policy or unprovable isolation is refused. The temporary rule is removed and a second install must retain the selected version. The final manifest normally equals its original bytes.

Both direct apply declarations and transitive temporary rules constrain resolution to the exact selected version during the first install. Direct final declarations then regain their original operator before the second install. This avoids npm selecting a higher release excluded by our security/timestamp checks; it does not leave permanent exact pins. Resolver installs run in a private temporary project using the same npm configuration and anchored path settings. Only verified dependency files are copied back after rechecking that the real project is unchanged. Then `npm ci` reproduces that pair in the real project. Invalid resolver output never touches user dependency files. Every install and ci runs with `--ignore-scripts` and `--min-release-age` of at least 7. No lifecycle scripts run. Projects needing install-time builds may require separate trusted setup and application tests afterward.

The selected installation must retain its location and consumers; its parents and every other installation of the same package remain unchanged. Necessary additions, removals, upgrades, and relocations within its dependency closure are allowed and reported as supporting changes. Unrelated graph changes and newly introduced vulnerable supporting versions fail verification. Other pre-existing vulnerabilities may remain.

## Git and failures

Before starting, both dependency files must be tracked, clean, regular nonsymlink files with a consistent npm lockfile v2/v3. The repository staging area must be empty. A local branch, existing HEAD, configured author/committer, and no ongoing Git operation are required. Workspaces, local/link dependencies and shrinkwrap are unsupported. Unrelated unstaged edits and untracked files are allowed and preserved.

After uncached security checks and installed-target verification, only changed dependency files are committed:

```text
deps: bump <package-name> from <old-version> to <new-version>
```

Nothing is pushed or tagged. Git hooks still run. Guards after pre-commit and message hooks reject changed files, staged content, branch state, or commit subject before Git creates the dependency commit. Git clean filters are respected for CRLF files while recovery retains original working-file bytes. A rejected commit leaves verified working changes for inspection/retry and removes only staging owned by this operation when safe.

Failures in the private resolver project leave original dependency files untouched. After publication, failures before Git staging restore captured dependency-file bytes when ownership and Git state still match. `node_modules` may have changed and can need rebuilding. Concurrent edits, staged work or HEAD movement are detected; recovery refuses to overwrite them. Inspect diagnostics and Git state if recovery cannot finish. A newly published advisory detected during application produces a stale-recommendation error and requires a fresh run; the same invocation never silently selects another version.

Completed reports exit 0 and use Markdown (default) or schema-version-2 JSON. JSON includes full ID, package, old/new versions, location, strategy, release timestamp, changed files, supporting changes and commit hash/subject. Errors exit 1 with stage-specific stderr and no success report on stdout.

## Tests

```sh
npm ci --ignore-scripts
npm test
```

E2E uses real local tool CLIs, npm, Git and tarballs against an isolated local registry/security service. It never depends on public vulnerability data. Provision pinned npm runtimes before starting the isolated tests:

```sh
npm install --prefix "$TEST_TOOLS/npm12" --ignore-scripts --no-audit npm@12.1.0
npm install --prefix "$TEST_TOOLS/npm11" --ignore-scripts --no-audit npm@11.10.0
export NPM_DEP_UPGRADE_E2E_NPM_CLI="$TEST_TOOLS/npm12/node_modules/npm/bin/npm-cli.js"
export NPM_DEP_UPGRADE_E2E_COMPAT_NPM_CLI="$TEST_TOOLS/npm11/node_modules/npm/bin/npm-cli.js"
export NPM_DEP_FLOW_TEST_TMPDIR="$TEST_SCRATCH"
export NPM_DEP_PATHS_TEST_TMPDIR="$TEST_SCRATCH"
export TMPDIR="$TEST_SCRATCH"
npm run test:e2e
```

Set `TEST_TOOLS` and `TEST_SCRATCH` to absolute directories first. Runtime selection variables are test-only. A requested missing compatibility runtime fails rather than silently skipping. Fixtures isolate npm user/global configuration, caches, Git configuration, hooks and scratch files. The default full suite covers npm12.1, genuine 7-character ID collisions, security drift, Git guards/recovery, supporting changes and clean `npm ci` reproduction. Compatibility tests cover npm11.10, lockfile v2 and absent initial `node_modules`. Windows CI runs the real D01/T01/O03/F06 smoke paths plus unit checks. See the [coverage map](test/e2e/COVERAGE.md) and [approved catalog](../../docs/superpowers/specs/2026-10-20-npm-dep-upgrade-e2e-cases.md).
