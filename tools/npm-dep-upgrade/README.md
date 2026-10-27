# npm-dep-upgrade

Upgrade one vulnerable npm installation selected by a fresh planner ID, verify it, and create one local Git commit per upgrade performed.

## Setup

Use Git 2.36 or newer and Node.js 24.21.0 with npm 12.1.0 as the reference runtime. npm 11.10.0 is covered by the documented compatibility subset. The selected npm on `PATH` is used throughout; this tool never installs or changes npm itself. Other npm versions are not covered by this matrix.

Each tool is independently installed. Install `npm-dep-paths`, `npm-dep-audit`, `npm-dep-versions`, and `npm-dep-upgrade-plan` and keep their commands on `PATH`, then install this tool from its directory:

```sh
npm ci --ignore-scripts
npm install --global . --ignore-scripts
```

## Usage

Pass an optional project directory before the item ID, or omit it to use the caller's current directory. Relative paths resolve against the caller's directory. Projects may be nested inside a Git repository:

```sh
cd '/path/to/my project'
npm-dep-upgrade-plan .
npm-dep-upgrade abc1234
npm-dep-upgrade "/path/to/another project" abc1234
npm-dep-upgrade ../another-project abc1234
npm-dep-upgrade <full-id> --package @scope/package --format json
npm-dep-upgrade --help
npm-dep-upgrade --version
```

With two positional arguments, the first is always the project directory and the second is the item ID, matching `npm-dep-paths`. Flags may appear before or after them. Git guards, npm configuration, installation and commits apply to the selected project; the caller's working directory is not changed.

The selector is a lowercase hexadecimal prefix of 7–64 characters. Planner JSON contains the full SHA-256 of `package + "__" + targetLocation`; Markdown shows seven characters. IDs identify package/location, independent of the installed version and absolute project path. A short prefix can collide. `--package` filters by exact package name before uniqueness checking; two locations of the same package may still need a longer prefix. Automation should use full IDs plus package names.

Each invocation reruns the schema-version-3 planner and executes all planned actions of one partial or complete finding: `upgrade-via-parent-dependency` actions first (ancestor level ascending, then location, name and version), then `update-within-declared-range` actions. Each action is reassessed against the tree left by the previous one and is skipped (`already-satisfied`, no commit) when its consumers are already cleared. A `none` finding is rejected. There is no choice-selection flag, plan-file input, or `--to`. A complete finding normally disappears; a partial finding leaves the incompatible vulnerable consumers in the next report, potentially at a different location/ID. Re-executing a remaining `none` finding changes nothing.

## Per-invocation configuration

Use `--config <path>` to load a JSON object explicitly. There is no automatic discovery, persistent setting, config inheritance, or modification of the config file. Each invocation starts from defaults. All settings below also have individual CLI options; the target ID always stays positional.

```json
{
  "project": "./webapp",
  "package": "joi",
  "format": "json",
  "debug": false,
  "module": "webapp",
  "commitMessageTemplate": "deps({module}): {description}",
  "gitCommitArgs": ["--no-verify"]
}
```

```sh
npm-dep-upgrade abc1234 --config ./upgrade.json
npm-dep-upgrade ./api abc1234 --config ./upgrade.json --module api
npm-dep-upgrade abc1234 --module webapp --git-commit-arg=--no-verify
npm-dep-upgrade abc1234 --config ./upgrade.json --no-debug --clear-git-commit-args
```

CLI values override JSON values, which override defaults. Repeatable `--git-commit-arg=<arg>` values replace the entire configured array. `--clear-git-commit-args` replaces it with an empty array and cannot be combined with `--git-commit-arg`. `--debug` and `--no-debug` explicitly enable or disable diagnostics, including propagation to invoked tools. Without an explicit debug setting, inherited `NPM_DEP_FLOW_DEBUG=1` still enables diagnostics.

Resolve the config path and positional project against the caller's directory. A relative JSON `project` resolves against the config file's directory. Without either project input, use the caller's current directory. The selected project supplies the working directory for invoked analysis tools, npm operations, and Git checks; the caller's working directory is unchanged.

| JSON key | CLI input | Default |
| --- | --- | --- |
| `project` | Positional project before the ID | Caller directory |
| `package` | `--package <name>` | No package filter |
| `format` | `--format markdown\|json` | `markdown` |
| `debug` | `--debug` / `--no-debug` | Inherited debug setting, otherwise disabled |
| `module` | `--module <name>` | No module scope |
| `commitMessageTemplate` | `--commit-message-template <text>` | See below |
| `gitCommitArgs` | Repeatable `--git-commit-arg=<arg>` | `[]` |

Unknown keys, invalid types, unreadable/invalid JSON files, malformed templates, and unsupported Git arguments fail before any project operation. JSON values must be valid even when overridden by CLI. Help and version bypass config loading. Config files contain only these settings, not the target ID, `config`, `help`, or `version`.

### Commit subjects

Without customization, the subject stays `deps: bump <package> from <oldVersion> to <newVersion>`. Supplying `--module webapp` changes it to `deps(webapp): bump <package> from <oldVersion> to <newVersion>`.

The default template is `deps: {description}` without a module, or `deps({module}): {description}` with one. Set `--commit-message-template <text>` or `commitMessageTemplate` to replace it. Supported placeholders:

| Placeholder | Value |
| --- | --- |
| `{module}` | Explicit module name; required if referenced |
| `{description}` | Strategy-supplied action, currently `bump <package> from <oldVersion> to <newVersion>` |
| `{package}` | Selected package name |
| `{oldVersion}` / `{newVersion}` | Installed / chosen version |
| `{strategy}` | `update-within-declared-range` or `upgrade-via-parent-dependency` |

Descriptions are supplied separately from the formatter, allowing a future strategy to provide wording such as `migrate Angular toolchain from …`. Parent upgrades use the same placeholders. Placeholder values are literal text, never executable code or nested templates. Unknown placeholders or unmatched braces are rejected. Templates and rendered subjects must be nonempty single lines without control characters or surrounding whitespace. Module names must be nonempty, without control characters, braces, parentheses, or surrounding whitespace. The actual rendered subject is protected by the commit guards and returned in the report's ordered `commits[].subject` fields.

### Git commit arguments

Each array entry or repeated CLI option is one literal Git argument, with no shell splitting. Supported arguments are `--no-verify`, `--signoff`, `--gpg-sign`, `--gpg-sign=<key>`, and `--no-gpg-sign`. Signing key identifiers can contain letters, digits, `@`, `.`, `_`, `+`, `/`, and `-`. Other arguments are rejected, including options that amend history, select files, replace the message, or alter hooks configuration.

`--no-verify` skips Git's pre-commit and commit-msg hooks. Git's prepare-commit-msg and post-commit hooks still run. The tool's staged-content, dependency-file, branch, HEAD, and subject guards remain active. `--signoff` appends the Git sign-off trailer without changing the subject. Signing uses your configured Git signing setup and can fail if that setup is unavailable.

## Selection and application

The tool chooses the newest stable version that is newer than the installed version, at least the planner's minimum safe version, safe under fresh candidate-version advisories, within every original incoming requirement of the selected consumers, and at least seven days old. It checks the chosen version's own release timestamp. Missing/invalid timestamps exclude a version; a valid older safe fallback is allowed. Effective stricter npm release-age and `before` cutoffs are preserved. A security service failure is an error. The planner's minimum timestamp alone does not establish candidate eligibility.

Direct dependencies in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` retain their section and literal `^` or `~` operator. For example, `~6.0.8` locked at 6.0.9 becomes `~6.0.12`. All compatible duplicate declarations are updated. Exact direct pins and unsupported declaration forms are outside this release's scope.

For transitive targets, temporary scoped overrides target only compatible consumers. Exact-pinned consumers remain valid on their old vulnerable version. A directly declared parent uses `".": "$parent-name"` within its scoped rule. Existing override policy is preserved; conflicting policy or unprovable isolation is refused. Temporary rules are removed before verification, and the final manifest normally equals its original bytes. No lockfile entries are patched by hand.

Equivalent selectors share their physical parent locations instead of expanding every ancestry route. Scope proposals are bounded to 1,024 entries and graph-node-count depth. The selected npm resolver constructs and serializes private lockfiles before any target files change. All actual installs use `--ignore-scripts` and at least seven days of release age.

A shared installation can split, reuse an existing safe installation, or relocate. Verification follows original incoming consumer relationships. Unrelated installations and unrelated target copies remain unchanged; selected consumers become safe, incompatible consumers retain valid original versions. Necessary supporting closure changes are verified for fresh security and release age. Remaining pre-existing vulnerabilities are permitted for a partial result.

All actions are resolved and their intermediate snapshots checked before committing. Each snapshot is installed with scripts disabled and checked against fresh security evidence. Only verified dependency-file pairs are published under concurrency guards. Each actual upgrade then receives its own commit, containing its required supporting changes. Several consumers accepting one safe version form one action and one commit; different safe-version actions can produce several commits for the same finding. Hooks see the matching snapshot and installed tree. There is no interactive review pause.

## Parent upgrades

A planner finding can contain `upgrade-via-parent-dependency` actions next to within-range actions. The executor validates each parent action against fresh evidence: the ancestor installation must be unchanged, within two levels of the selected installation, the covered consumers must be real consumers of it, and the planned release must still exist, be stable, be old enough (the seven-day floor and any configured cutoff), satisfy every incoming declaration on the ancestor, and not be affected by a fresh advisory. If the planned release is no longer eligible, the lowest newer eligible release is used instead; resolution must land on it and still produce the planned coverage, otherwise the plan is stale. A lower release is never chosen.

Parent actions run first, ordered by ancestor level, then original location, name and version; within-range actions follow. Each parent action is applied through npm's named update (no overrides, no hand-edited lockfile): the ancestor lands exactly on the planned release, and the installations that release brings in are then resolved again under the release-age policy from npm configuration (`min-release-age`, never fewer than seven days, bounded by `before`), so nothing newly installed is younger than the policy and no older release is used than the policy allows. Within-range actions keep their scoped overrides. Every action is verified in private staging; after each one the tree is reloaded and the remaining actions are reassessed. An action whose consumers were already cleared (for example when the parent's safe pin let npm dedupe the shared installation) is reported with outcome `already-satisfied` and creates no commit. A parent that removes the dependency clears its branch, but the residual consumer is still upgraded in its own second commit. Nothing is committed until the whole combined result, expected resolution, fresh advisories, release ages and a scripts-disabled installed tree, has been verified. Each actual upgrade then gets its own commit with the configured template and hooks; if a later commit fails, earlier commits are preserved and reported.

## Fresh security checks on changed versions

Before anything is committed, every version a snapshot installs or changes is checked against fresh advisories (the registry's bulk advisory endpoint and a fresh audit of the staged tree) and against the release-age policy. A changed supporting version, including the parent release itself, is accepted when it adds no advisory that the version it replaces did not already have, compared by advisory ID: swapping an affected `6.0.0` for an affected `6.0.2` with the same advisories is not worse, so it is allowed. It is refused when it gains an advisory, or when the package had nothing to replace and has any advisory. The version selected for the vulnerable package itself must be free of advisories. Repository checks such as GitHub's dependency-review may still flag such a change; that decision stays manual.

## Git and failures

Before starting, both dependency files must be tracked, clean, regular nonsymlink files with a consistent npm lockfile v2/v3. The repository staging area must be empty. A local branch, existing HEAD, configured author/committer, and no ongoing Git operation are required. Workspaces, local/link dependencies and shrinkwrap are unsupported. Unrelated unstaged edits and untracked files are allowed and preserved.

After uncached security checks and installed-target verification, only changed dependency files are committed:

```text
deps: bump <package-name> from <old-version> to <new-version>
```

Nothing is pushed or tagged. Git hooks run by default; explicitly configured `--no-verify` skips pre-commit and commit-msg. Guards after pre-commit and message hooks reject changed files, staged content, branch state, or commit subject before Git creates the dependency commit. Git clean filters are respected for CRLF files while recovery retains original working-file bytes. A failed first commit restores owned dependency files when guards permit; node_modules may need rebuilding. If a later commit fails, earlier commits remain and diagnostics identify their hashes. A verified commit created before a post-commit check fails is also retained and identified; hook edits remain untouched. Remaining verified changes can stay uncommitted. The tool never resets history and removes only its own staging when safe.

Failures in the private resolver project leave original dependency files untouched. After publication, failures before Git staging restore captured dependency-file bytes when ownership and Git state still match. `node_modules` may have changed and can need rebuilding. Concurrent edits, staged work or HEAD movement are detected; recovery refuses to overwrite them. Inspect diagnostics and Git state if recovery cannot finish. A newly published advisory detected during application produces a stale-recommendation error and requires a fresh run; the same invocation never silently selects another version.

Completed reports exit 0 and use Markdown (default) or schema-version-3 JSON. Partial remediation is a successful operation. JSON includes `id`, `package`, `oldVersion`, original `targetLocation`, final `resolution`, ordered `actions`, and ordered `commits`. Actions include strategy, original and actual target versions/locations, affected consumers, outcome (`applied` or `already-satisfied`), release timestamp, and supporting changes. Supporting changes record added, updated, and removed installations; removals have `newLocation: null` and `newVersion: null`. Commits include `hash`, `subject`, `actionIndex`, and `changedFiles`. The old singular `newVersion`, `strategy`, `commit`, and `changedFiles` result fields are replaced by these arrays. No schema-version-2 reader is provided.

Errors exit 1 with stage-specific stderr and no partial success report on stdout. A failure before commits leaves no upgrade commits; a failure after a committed prefix preserves and identifies that prefix.

## Clearing analysis caches

The upgrader keeps no cache of its own, but it reads the planner's cached plan. If that plan is stale or was produced by outdated code, rerun with `--clear-cache`:

```sh
npm-dep-upgrade /path/to/project <item-id> --clear-cache
npm-dep-upgrade --clear-cache
```

The flag is forwarded to `npm-dep-upgrade-plan`, which deletes its whole cache directory and clears audit, paths and versions caches through the chain, then plans normally and writes fresh entries. Running the planner with `--no-cache` cannot repair a bad entry because it neither reads nor replaces cached data. With `--clear-cache` the item ID is optional: `npm-dep-upgrade --clear-cache` only asks the planner to clear its chain (`npm-dep-upgrade-plan --clear-cache`, clear-only) and exits 0 without touching Git or the project. A cache that cannot be cleared is an error and no upgrade starts. The option is a command-line flag only; it has no configuration-file key.

## Debug logging

Use `--debug` to write external-action diagnostics to stderr while keeping the report on stdout:

```sh
npm-dep-upgrade /path/to/project <item-id> --debug --format json > report.json 2> debug.log
```

Logs show commands, arguments, working directories, durations and exit outcomes. Debug mode propagates through sibling tools, and their debug records stream to the caller. This includes npm installs, Git commands, the hook runner and direct HTTP security requests. Cache hits, misses and bypasses explain when analysis is reused; debug mode preserves normal caching.

Credentials in logged arguments and URLs are redacted. Debug records omit environment values, request bodies and subprocess output. Existing error diagnostics and installation progress retain their usual behavior. See the [shared debug guide](../../README.md#debug-logging) for propagation and scope.

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

## Parent upgrades: schema decision

The planner contract stays at schema version 3. Parent choices (`upgrade-via-parent-dependency`) reuse the existing choice fields, so the mutator needs no new planner field: `targetPackage`, `targetLocation`, `currentVersion` and `targetVersion` describe the ancestor, and `affectedConsumers` lists the covered branches of the selected finding. Validation is strategy-aware; within-range choices keep their original checks. No older-schema reader is provided.
