# npm-dep-upgrade design

## Intent and agreed outcome

Add `npm-dep-upgrade`, an independent CLI that remediates one vulnerable package installation selected from a fresh `npm-dep-upgrade-plan` report. A person supplies a short item hash; automation supplies the full hash and optionally the exact package name. Neither needs to type a `node_modules` path or save a planner JSON file.

One successful invocation selects one installation, chooses the newest safe version permitted by the existing requirements and seven-day release-age policy, applies the upgrade, removes temporary overrides, verifies the result, and creates one local Git commit. The upgraded package may bring changes to its own dependencies. Other installations of the selected package must remain unchanged.

The scope is only `update-within-declared-range`. Parent upgrades, forcing versions outside original requirements, exact-pinned direct dependencies, batch execution, orchestration, pushing commits, and additional remediation strategies are excluded. There is no `--to`, saved-plan input, item-number selector, or interactive confirmation step.

This specification incorporates the reviewed [E2E catalog](2026-10-20-npm-dep-upgrade-e2e-cases.md). Its final addendum records decisions made after the initial catalog, including the revised F03 recovery case. It supersedes the earlier planner design's placeholder discussion of a future mutator; the planner's existing strategy meaning remains unchanged.

## Tool boundaries and supported projects

Keep `tools/npm-dep-upgrade/` independent, with its own manifest, lockfile, executable, source, tests, and README. Do not turn the repository root into an npm workspace or import private sibling-tool source.

Use the separately installed planner, audit, and paths CLIs through their documented JSON contracts. The planner supplies item identity and eligibility. Fresh audit and paths results supply advisories, incoming requirements, requested names, and parent locations needed to validate and apply the change.

Support ordinary single-package registry-backed npm projects with lockfile versions 2 and 3. Retain the existing exclusions for workspaces, local links, `file:` dependencies, shrinkwrap, and other package managers. The project root is the optional positional project directory, defaulting to the caller's current directory, and must contain tracked `package.json` and `package-lock.json` files in a Git working tree. The Git repository may contain the project below its root.

Direct application supports literal caret and tilde semantic-version requirements in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`. Preserve the section and operator. If a direct package has multiple applicable declarations, they must all be supported and admit the selected version; update all of them. An exact or otherwise unsupported direct declaration prevents application to that shared installation. Preserve `peerDependenciesMeta` and optional-dependency precedence.

Transitive requirements use the semantic-version range semantics already supported by the planner. A newer candidate must satisfy every original incoming requirement for the selected physical installation. Unsupported alias/replacement requirements or override scope that cannot be expressed without changing other target installations produce an applicability error, not a new remediation strategy.

The default development and E2E npm runtime is exactly 12.1.0; compatibility tests use exactly 11.10.0. Runtime subprocesses use the selected `npm` on `PATH`, consistently for the new tool and its sibling CLIs. Do not download npm or change global installations automatically. Document 12.1.0 as the reference runtime and 11.10.0 as the compatibility runtime; do not imply that this test matrix proves behavior on every later release. Use a Node.js runtime compatible with the selected npm; the E2E reference runtime is Node.js 24.21.0.

## Planner item IDs

Add an `id` field to every planner JSON row, including ineligible rows:

```text
id = lowercase hexadecimal SHA-256 of UTF-8(package + "__" + targetLocation)
```

Example hash input:

```text
brace-expansion__node_modules/minimatch/node_modules/brace-expansion
```

`package` is the report's resolved package name. `targetLocation` is the canonical project-relative installation location from the lockfile, using `/` separators and no leading `./`. Validate the location rather than accepting absolute paths, traversal, or alternate spellings. Installed version, advisory state, registry, project absolute path, and timestamps do not enter the hash.

JSON contains all 64 hexadecimal characters. Markdown gains an ID column containing the first seven. Preserve the existing schema version 2 envelope, fields, ordering, strategy semantics, and exit behavior; `id` is an additive field. Old consumers may ignore it. The new mutator requires it and validates each value by recomputing the hash. Empty planner output retains its existing no-findings behavior.

An ID identifies a package/location within the current project, not a historical version or a globally unique project. It stays the same when that installation changes version, provided the planner still reports it. Duplicate full IDs in a report are an error for selection; never silently merge rows.

## CLI and selection

```text
npm-dep-upgrade [project] <id-or-prefix> [--package <name>] [--format markdown|json]
npm-dep-upgrade --help
npm-dep-upgrade --version
```

The selector accepts lowercase hexadecimal strings between 7 and 64 characters. Accept one positional argument as the item ID in the current directory, or two as project directory followed by item ID, matching `npm-dep-paths`. Resolve relative project paths against the caller's directory. Reject missing or invalid selectors, more than two positional arguments, and unsupported options before project mutation. Option order may vary. The default output is Markdown, consistent with sibling tools. `--help` and `--version` need no project or Git repository; version output includes the tool version and absolute installed tool directory.

Normal execution invokes `npm-dep-upgrade-plan . --format json` with the selected project as its working directory. Git guards, npm configuration, evidence, installation and commits all use that project; the caller's working directory is not changed. Match the selector as a prefix of the returned full IDs. Apply the optional exact package-name filter before checking uniqueness. Selection requires one matching row and the `update-within-declared-range` strategy with eligible status. Invalid planner output, zero matches, ambiguous matches, an ineligible match, or an unsupported strategy exits with an error and no project changes.

Ambiguity diagnostics list package, old version, location, and full ID for each candidate. Suggest a longer hash or the package-name filter. A package-name filter can disambiguate different packages, but cannot guarantee uniqueness for prefix collisions between locations of the same package. Full IDs are recommended for automation. Unexpected full-ID collisions must still fail.

Do not select the first eligible row automatically. If an earlier upgrade removed the selected finding, a repeated command returns target-not-found without installing or committing. This supersedes the initial F05 expectation of a generic no-findings success on the second invocation.

The planner's audit can be cached under its existing contract. The mutator must independently obtain fresh audit data before accepting the selected recommendation and after application; invoking the planner again is not itself proof that advisory data is fresh.

## Git preconditions and initial snapshot

Before invoking mutation commands, require:

- Both dependency files are tracked, present, nonsymlink regular files and match their Git index and HEAD contents.
- The repository-wide staging area is empty, including staged changes outside the project.
- HEAD is on a local branch with an existing commit and no merge, rebase, cherry-pick, or revert in progress.
- Git author/committer identity is available for the eventual commit.

Unrelated unstaged files are allowed and must not be staged, restored, or committed. Untracked or dirty dependency files cause an early refusal; do not offer an implicit stash or blanket restore.

Capture original manifest and lockfile bytes, repository HEAD, and semantic dependency graph before applying changes. Recheck relevant preconditions immediately before the first write and commit. Do not include concurrent user/index/HEAD changes in the operation or overwrite them during recovery. Concurrent invocations against one project are unsupported; detect changed state and fail rather than resetting the repository.

## Candidate selection and release age

After selecting the fresh planner row, validate that its location currently contains the reported package and old version. Reconstruct all incoming links using the public paths/audit contracts. Ensure that fresh findings still justify the row and that the strategy remains applicable. Disagreement is a stale recommendation.

Retrieve published versions and release times through the target project's effective npm registry configuration. Select the greatest strict stable semantic version satisfying all of these conditions:

1. It is newer than the installed version.
2. It is at least the planner's `minimumSafeVersion`.
3. Every original incoming requirement for the selected installation admits it.
4. No applicable known advisory identifies it as vulnerable.
5. Its verified publication time is at least seven days before selection time.

`minimumSafeVersion` is a lower bound, not a complete statement that every higher version is safe. `minimumSafeVersionReleasedAt` applies only to that version, not to the eventual selected candidate. Missing or invalid candidate timestamps exclude that candidate. A too-young minimum version does not rule out a higher version published earlier. If no candidate remains, fail before installing.

Preserve the planner's existing minimum-safe reporting and ascending strategy candidate behavior. The new tool independently selects the newest eligible application candidate; do not change the planner's candidate policy as part of adding IDs.

Candidate safety must include advisories affecting candidate versions even if those advisories do not affect the currently installed old version. The audit tool intentionally reports only advisories matching installed versions, so those rows alone are insufficient for this check. The new tool's registry-security adapter queries the effective audit registry's bulk advisory API with the candidate versions and validates the returned advisory ranges. Reuse npm's effective project/user/global configuration and authentication through supported npm configuration/request libraries; do not read a global npm installation's private modules, dump protected configuration, or print credentials. Failed or malformed security responses are errors, not empty advisory lists.

All install subprocesses explicitly use `--ignore-scripts` and `--min-release-age=7`; do not depend only on the user's global setting. Keep the selected-version check independent of npm's filter and enforce it again on the resolved graph. Do not relax effective stricter cutoffs or package restrictions to make an installation succeed. Audit and installation use the same intended registry context. Registry/package policy conflicts are errors, not automatic exemptions.

## Applying direct updates

For a direct requirement, replace the lower-bound version while keeping the operator and dependency section. For example, `^6.0.8` becomes `^6.0.12`, and `~6.0.8` becomes `~6.0.12`. Do not convert to a permanent exact pin or add another dependency section.

Write only the intended manifest edits, preserving unrelated fields and formatting where practical, then invoke npm install with the required flags. The resolved target must equal the selected version. A newer permitted version appearing between selection and installation is not permission to silently change the selected target; detect the mismatch and fail the attempt.

## Applying transitive updates and cleanup

Build the narrowest expressible version-qualified parent/ancestor override scope for the selected installation. For a direct parent, preserve its declared specification using the approved reference form:

```json
{
  "overrides": {
    "package-a@1.2.4": {
      ".": "$package-a",
      "target-dep": "^6.0.12"
    }
  }
}
```

For a parent that is not directly declared at the root, do not introduce a `$` reference to a nonexistent root declaration. Preserve any valid existing `"."` entry. Parent version qualifiers and ancestor nesting are selectors, not proof of a unique physical installation; check their actual affected links. Multiple compatible parents sharing the selected installation may require temporary rules for each affected branch.

Use the public `npm-dep-paths` direct-dependent records for the selected `targetLocation` to propose immediate-parent scopes first. Cross-check these records against the installed graph and require coverage of all original incoming consumers. Only if the immediate scopes fail isolation, expand ancestor contexts incrementally using the compact upstream nodes and edges. Group equivalent selector sequences while retaining their physical head locations, and validate every merged proposal with Arborist. Do not enumerate every root-to-parent ancestry route before attempting a scope. Bound deeper searches by 1,024 distinct scope entries per proposal and the graph's node count in depth; reaching a bound without proof is a safe refusal.

Do not automatically fall back to a global `target-dep@old-version` rule. Override selection can match overlapping declared ranges, including exact pins, rather than only copies installed at that old version. Inspect original requirements before mutation; an incompatible incoming exact pin makes the whole shared installation ineligible. Do not force that branch temporarily, split it automatically, or upgrade its parent.

Merge temporary entries into an existing overrides object without dropping unrelated entries. A conflicting pre-existing policy prevents application; do not silently replace user policy. Record the exact inverse manifest edits, including any existing values temporarily adjusted in a compatible scope.

Run install with scripts disabled and the age policy. Validate the selected target and scope, remove the operation-created target rules, restore temporarily adjusted pre-existing values, and remove only containers created by this operation that are now empty. Preserve unrelated pre-existing overrides and the new lockfile. Run install again with the same flags and verify that the target remains at the selected version without the temporary rules.

If cleanup reverts or relocates the target, broadens the mutation to another target installation, or leaves an invalid graph, the attempt fails. Do not turn the temporary rule into a permanent workaround. The final root manifest for a transitive-only success ordinarily equals its original bytes; the parent package's published child requirement is not rewritten.

## Allowed graph changes and verification

Exactly one selected package installation is the remediation target. Its original location must still contain the selected name and new version after cleanup, and original incoming consumers must resolve it correctly. Every other pre-existing installation of that selected package must retain its version and location. Repeated parent name/version branches must be checked individually.

Supporting dependencies may be added, removed, upgraded, or relocated when required by the selected release or npm's resolution of its dependency closure. For example, a target changing its helper requirement from `^2.0.0` to `^3.0.0` may bring in a 3.x helper. This is not another parent-upgrade strategy or a second selected remediation.

Attribute supporting changes to the selected target's before/after transitive dependency closure and validate all incoming consumers of shared supporting nodes. Existing installations outside that closure must retain their versions and resolutions; parent packages and unrelated direct requirements must not be upgraded. Reject unexplained unrelated changes and invalid incoming requirements. Lockfile bookkeeping or formatting differences alone are not an additional package upgrade.

Verification checks manifest/lock consistency, the target's exact resolved version, original requirement satisfaction, stable-version and age eligibility, temporary-rule removal, parent versions, other copies of the selected package, and allowed supporting changes. For lockfile version 2, keep its legacy dependency representation consistent with `packages`.

Perform fresh, uncached advisory verification after cleanup for the selected package and changed supporting dependency versions. The target must have no applicable vulnerability; changed supporting nodes must not introduce a new directly vulnerable package/version. Pre-existing unresolved findings outside the operation may remain. Do not interpret npm audit's nonzero findings status alone as proof that this operation failed or succeeded; inspect the relevant findings.

If advisory data invalidates a selected recommendation during application, report a stale recommendation and require a fresh invocation. Do not silently retry with another candidate or commit the now-vulnerable change. Application compatibility is outside this tool's proof: project builds/tests can be run separately, and skipped lifecycle scripts may leave packages needing additional setup.

## Commit and recovery behavior

After verification, recheck the allowed diff and Git preconditions, stage only the project's changed `package.json` and/or `package-lock.json`, and create one local commit:

```text
deps: bump <package-name> from <old-version> to <new-version>
```

Use the complete resolved package name and versions observed before/after the operation. The commit may include required supporting dependency changes in the lockfile, but its subject describes the one selected upgrade. Respect normal Git author identity and hooks. Do not push, amend, create a release tag, or include unrelated files. Confirm the resulting commit's changed paths and resulting state before reporting success.

A failure before mutation leaves project files and staging unchanged. An installation, cleanup, graph-validation, or stale-advisory failure before staging restores the captured manifest and lockfile bytes if they are still owned by this operation. Do not use Git restore/reset to erase user work. `node_modules` may already have changed: report this explicitly, rather than claiming a complete installed-tree rollback. Recovery failure is reported alongside the original failure and no success output is emitted.

If Git commit fails after successful dependency verification, keep the verified dependency-file changes for inspection/retry, remove only this operation's staging where safe, and report that no successful commit was completed. Do not reset HEAD or erase hook/user changes. If a hook actually created a commit or changed files, inspect and report the resulting state instead of automatically rolling it back or making a second commit.

## Output and exit contract

Success exits 0 after creating and confirming the commit. Markdown begins with `# npm-dep-upgrade` and summarizes full item ID, package, old/new versions, target location, changed dependency files, supporting changes, and commit hash. It describes targeted remediation, not an assertion that the whole project is vulnerability-free.

JSON success uses `schemaVersion: 2` with `id`, `package`, `oldVersion`, `newVersion`, `targetLocation`, `strategy`, `releasedAt`, `changedFiles`, `supportingChanges`, and `commit` fields. `strategy` is `update-within-declared-range`; `changedFiles` contains project-relative paths; `commit` contains the confirmed full commit hash and subject. `supportingChanges` records each supporting package's name, old/new locations and versions, with null for the missing side of additions/removals. Emit one completed result only after verification and commit; route npm progress and diagnostics to stderr.

Invalid input, unmet preconditions, missing/ambiguous/ineligible targets, no acceptable candidate, unsupported scope, stale recommendations, and operational failures exit 1 with a stage-specific stderr diagnostic and no success report on stdout. Include whether dependency files were restored, changes remain uncommitted, or the installed tree may need rebuilding. Do not echo tokens, authentication configuration, or unbounded child output.

## Internal responsibilities

- CLI orchestration: parsing, staged execution, and completed-result output.
- Planner adapter: invoke the public command, validate schema/IDs, select one row.
- Audit/paths adapters: obtain fresh advisory and requirement/location evidence through public CLIs.
- Registry adapter: npm metadata queries, authenticated candidate advisory checks, timestamps, stable ordering, and per-run query reuse.
- Candidate evaluator: pure validation/selection over requirements, advisories, release times, and the captured reference time.
- Mutation builder: minimal direct edits or scoped temporary override edits with reversible change records.
- Installer: portable npm spawning with required flags and bounded diagnostics.
- Graph verifier: selected-location invariants, supporting-change attribution, and verification after cleanup.
- Git/recovery adapter: initial cleanliness, snapshots, allowed staging, commit verification, and safe failure reporting.
- Renderers: consistent Markdown/JSON success output.

## Verification and delivery scope

The companion E2E catalog is normative together with its final addendum. Run the real CLIs, npm resolver/installer, and Git against isolated fake registry/advisory services and real fixture tarballs. Do not mock npm install as the primary proof of resolution or cleanup. Use scoped caches/configuration and deny unexpected public network access. Use actual seven-character collisions for prefix E2E cases; impossible-to-construct full SHA-256 collision behavior belongs in adapter/unit fault-injection tests.

Default execution uses npm 12.1.0, with the documented npm 11.10.0 compatibility subset. Include real clean `npm ci --ignore-scripts` reproduction, scripts-suppression sentinels, dirty/staged Git refusal, exact commit contents, required supporting upgrades, preserved other target installations, and fresh advisory checks. Freeze time for pure boundary tests; generate generously separated timestamps from one case reference time for npm subprocess tests. Use explicit phase checkpoints for advisory changes and failures, not sleeps.

The implementation plan must include the independent new tool, planner ID fields and Markdown column, focused tests, repository guide/README updates, and a minor version bump for the existing planner in the final planned version commit. Existing audit/paths contracts remain unchanged unless a later review demonstrates a necessary public-interface change. The repository-wide read-only rule must be narrowed to the three analysis tools; the new mutator's install/write/commit permissions must be documented explicitly. No implementation or tool-version changes occur in this design-document commit.

Development worktrees belong under `/home/maw/src/nrc/npm-dep-flow-impl/worktrees/`; development and test temporary files belong under `/home/maw/src/nrc/npm-dep-flow-impl/tmp/`. Preserve the reviewed temporary draft. Runtime recovery snapshots must live outside tracked project files and honor the configured temporary-directory policy.

This written specification is submitted for user review. After approval, create a separate implementation plan with intended commits, then select its execution method before starting implementation.
