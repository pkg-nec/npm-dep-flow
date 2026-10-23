# Partial remediation and upgrades through parent dependencies

Date: 2026-10-23

## Intent and agreed constraints

Extend npm-dep-flow so one vulnerable installation can be remediated through
compatible consumers even when other consumers pin the vulnerable version.
Subsequently add upgrades through parent dependencies. Keep the work incremental
and independently reviewable in two PRs.

The user requires:

- PR 1 first simplifies the existing strategy's Markdown label. Its second
  section adds partial within-range remediation, replaces `status` with
  `resolution`, and introduces planner JSON schema version 3.
- PR 2 introduces parent upgrades. Search immediate parents first, then their
  parents, with a maximum of two ancestor levels. Stop climbing each affected
  branch once a suitable candidate is found. Do not expose search status.
- Parent upgrades satisfy all incoming declared requirements, introduce no
  override entries, and do not edit lockfiles by hand. npm resolution maintains
  manifest/lockfile synchronization.
- One finding represents one vulnerable physical installation, independent of
  its remediation strategies. Separate installations remain separate findings.
- Selecting an item in the upgrade tool executes all its planned actions. Do not
  introduce a choice selector or interactive selection.
- Perform parent actions before residual within-range actions. Resolve and
  verify the complete transaction before committing. Create one commit per
  upgrade actually performed, rather than one commit for the entire finding.
- PR 2 may introduce planner schema version 4 if required. No version 2 migration
  or compatibility layer is required.

Development checkout: `/home/maw/src/nrc/npm-dep-flow-impl/npm-dep-flow`.
Task scratch files belong under `/home/maw/src/nrc/npm-dep-flow-impl/tmp`;
new worktrees belong under `/home/maw/src/nrc/npm-dep-flow-impl/worktrees`.
These paths are development constraints, not hardcoded paths for users' CLIs.

## Current behavior and boundaries

The planner groups audit requirements by target installation location. The
existing evaluator offers `update-within-declared-range` only if a newer safe
stable version satisfies every incoming requirement for that installation.
Markdown currently includes the package/version transition in its Strategy cell.

The executor accepts one item ID, validates schema version 2, chooses a fresh
safe candidate, resolves in private staging, verifies isolation, publishes the
dependency files, installs with scripts disabled, and commits verified changes.
Its graph verifier currently requires the original target location and parents
to remain unchanged. Those assumptions must change for consumer splitting and
parent upgrades.

Tools remain independent packages and exchange data through public CLI JSON.
Do not import another tool's private modules. Preserve supported-project limits,
portable subprocess handling, npm configuration context, cache freshness,
scripts-disabled installation, release-age policy, and Git/concurrency guards.
The requested planner schema changes intentionally supersede the repository's
general instruction to preserve planner schema version 2; other public contracts
remain unchanged unless specifically changed and documented in their PR.

## PR 1: incremental within-range remediation

### Section 1: Markdown presentation only

Change the existing Strategy cell from
`Update within declared range: A@1.2.3 → A@1.2.5` to
`Update within declared range`.
Keep all existing JSON details and behavior at this step. This is the first
implementation change and must be independently inspectable in the commit order.

### Section 2: consumer coverage and schema version 3

Replace the requirement that every consumer accept the same safe upgrade with
evaluation of compatible subsets of incoming consumer edges. An edge is
identified by its original consumer location, requested dependency name, and
declaration type. Retain the original declared requirement as evidence.

A safe candidate is newer, stable, and outside all relevant advisory ranges.
An action may cover only consumers whose requirements accept its candidate.
Incompatible consumers retain a valid resolution to the old version. No consumer
may be forced outside its declaration. If several candidates are needed to cover
different compatible subsets, represent them as separate actions. Prefer a
candidate covering more remaining consumers; break ties by the lowest safe
version, then deterministic version-string ordering. Repeat for uncovered
consumers. This is deterministic coverage selection, not exhaustive optimization.

Fresh executor selection retains the existing security and release-age policy;
an alternate candidate must preserve the planned consumer coverage and scope.
Do not silently broaden action scope or weaken security to execute stale data.

The executor must allow the original shared installation to split. Covered
consumers resolve safely, while uncovered consumers remain valid and unchanged
in meaning. A safe version may reuse an existing installation. Old and new
installations may relocate during npm resolution. Verify logical consumer
relationships rather than assuming the old target path persists.

Existing reversible scoped-override machinery remains available for the
within-range strategy, subject to isolation checks and cleanup. The prohibition
on new override entries is specific to the parent strategy in PR 2. Never patch
`package-lock.json` to manufacture an installation split. If npm cannot express
and retain an isolated valid split, reject the mutation rather than forcing it.

Introduce a read-only candidate-resolution boundary in PR 1 so the planner can
establish that proposed consumer splits and action combinations are feasible.
Resolve against private copies of manifest/lockfile inputs using npm-compatible
semantics and effective npm configuration, without installing dependencies,
running scripts, or modifying target files. Reuse equivalent resolution and
scope rules in the executor through independently implemented public contracts,
not cross-tool private imports. Resolver failures are errors; a valid result
with no expressible safe action produces `none`. Cache resolved plans with
dependency-file content, effective context, resolver/tool versions, and original
metadata freshness. Preserve cache bypass and credential-digest safeguards.

### Finding identity and resolution

Keep the existing full SHA-256 ID of `package + "__" + targetLocation`.
Installed version is a row field, not part of the ID. Resolution and strategies
never create additional findings for the same package/location.

Replace `status` with exactly one of:

- `none`: no available planned action clears an affected consumer branch.
- `partial`: the action set clears at least one affected branch, but some remain.
- `complete`: the combined action set clears all affected branches of this
  original vulnerable installation for the relevant advisories.

These describe available remediation, not a claim that the project has already
been changed. Removing a dependency clears its branch. Relocating a vulnerable
version or replacing it with another affected version does not clear a branch.
Unrelated vulnerable installations remain separate findings.

### Planner JSON contract

Schema version 3 retains `auditedAt` and `rows`. Rows retain `id`, `package`,
`version`, `targetLocation`, `severity`, `minimumSafeVersion`, and
`minimumSafeVersionReleasedAt`. Remove the singular `strategy` and `status`.
Add `resolution` and `choices`.

Each choice contains:

- `strategy`: `update-within-declared-range` in PR 1.
- `targetPackage`, `targetLocation`, `currentVersion`, `targetVersion`.
- `affectedConsumers`: entries containing original `location`, `requestedName`,
  and `type`, identifying the selected finding's branches this action addresses.

`choices` is one compatible, deterministic set of planned actions, not mutually
exclusive alternatives. No choice IDs, `completeResolutionOptions`, ancestor
search fields, or legacy schema readers are needed. `none` has `choices: []`.

For one installation, several planned actions can be individually partial while
their combined effect is complete. Combined coverage must be established through
dependency resolution, not merely by unioning independent metadata claims.

### Markdown contract

Retain the existing finding columns except replace Status with Resolution.
Keep one row per finding and short finding IDs. The Strategy cell lists distinct
strategy descriptions in deterministic order. Within-range descriptions contain
only `Update within declared range`, even if several actions use that strategy.
Preserve severity styling, escaping, release dates, empty-report behavior, and
normal exit codes. An item with `none` has no strategy, rendered as an em dash.

### Executor contract

Keep `npm-dep-upgrade [project] <id-or-prefix>` and the optional exact package
filter. Read only planner schema version 3 in PR 1; reject old schemas clearly.
Accept both partial and complete findings, reject `none`, and execute every
required action without a new selection flag.

## PR 2: upgrade through parent dependencies

### Bounded discovery

First account for consumers covered by within-range actions. For unresolved
branches, evaluate immediate-parent releases that satisfy every incoming declared
requirement on that parent installation. If no suitable candidate is found,
evaluate its immediate parents, reaching at most two levels above the vulnerable
installation. The project root is not an upgradable package.

Stop climbing a branch as soon as a suitable candidate is found at its current
level. A success for one branch does not prevent discovery for another unresolved
branch. Within a level, use deterministic parent/location and stable-version
ordering; prefer the lowest suitable newer stable version. Do not search higher
levels for an allegedly better solution after success.

All incoming constraints on a selected ancestor apply, including shared consumers
outside the branch that led to discovery. Respect aliases, dependency types,
existing override policy, and required peer constraints. Do not treat an
incompatible parent upgrade as an executable candidate.

Use visited sets and adjacency indexes rather than enumerating every upstream
route. Deduplicate parent candidates and exact-version metadata requests across
findings. Reuse catalogs with their original freshness and npm context. The
two-level bound is an internal constant in this delivery, with no new depth flag.

### Suitability and read-only planning

An ancestor release is suitable only when its resolved affected dependency
closure clears the corresponding vulnerable branches: it uses safe versions or
no longer reaches the affected package. A changed or removed direct declaration
alone is insufficient; another descendant can still introduce the vulnerability.

Extend PR 1's read-only candidate resolver for ancestor actions and mixed action
sets, accounting for changed descendant closures. It may fetch metadata, but
must not install dependencies, run lifecycle scripts, or modify target files.
Fail closed on malformed metadata or resolver failure; do not label a speculative
combination complete.

Follow existing public paths CLI graph outputs to discover ancestors. Any needed
public graph extension must be explicitly documented and tested; do not reach
into paths internals. Cache identity must cover the action set, graph inputs,
resolver/tool versions, relevant npm context, and all metadata source freshness.
Preserve bypass propagation and do not store credentials.

### Reporting additions

Add choice strategy `upgrade-via-parent-dependency`. Its target fields identify
the ancestor being upgraded; `affectedConsumers` identifies covered branches of
the original finding, not incoming edges on the ancestor itself.

In Markdown display, for example:
`Upgrade via parent dependency: B@1.0.1 → B@1.1.0`.
Keep transitions for this strategy because the parent package is useful
information. A mixed item displays the within-range label and parent transitions.
Do not display ancestor search status or negative candidate lists.

Use planner schema version 3 if these additions fit its action model; otherwise
make a coordinated change to version 4 in planner and executor. No schema version
2 migration is needed, and no version 3 compatibility layer is required if PR 2
moves to version 4. Do not introduce speculative PR 2-only fields in PR 1.

## Transaction execution and commits

The transaction covers all upgrades selected for one finding. Its phases are:

1. Load a fresh current plan, preserve original consumer identities, and perform
   existing Git, dependency-file, npm-context, and fresh security checks.
2. In private staging, execute ancestor upgrades before residual within-range
   actions. Sort parent actions by ancestor level ascending, then original
   location/name/version. Deduplicate upgrades targeting the same ancestor.
3. After each action, reload the graph and reassess remaining obligations. Skip
   an action whose intended safe resolution or dependency removal is already
   satisfied. Rebind moved installations through consumer edges; do not reuse
   stale paths blindly. Abort on ambiguity or an incompatible action set.
4. Save synchronized dependency-file snapshots after each actual upgrade.
   Snapshots include npm-produced supporting changes. Validate intermediate
   snapshots for graph correctness, isolation, and security of changed versions.
5. Validate the entire combined result, including expected partial/complete
   coverage, fresh advisories, release ages, and a scripts-disabled installed-tree
   check. No commits are created before this succeeds.
6. Publish/replay each verified snapshot in order, checking ownership and
   concurrency before every write and commit. Hooks must see the corresponding
   snapshot. Create one commit per actual upgrade and update the expected Git
   guard baseline after each tool-owned commit.
7. Return the performed actions, skipped/already-satisfied actions, final
   resolution, and an ordered list of commit hashes and subjects. Document and
   version executor JSON changes explicitly in the implementation plan.

One action includes all necessary supporting dependency changes it produces; do
not split a single npm-produced action into package-by-package commits. Honor the
existing commit template/module/argument settings for every action. No-op or
already-satisfied actions create no empty commits.

An upgrade/resolution/verification failure before committing aborts the whole
transaction and restores owned files under existing concurrency guards. Git
commit creation is not atomic across multiple commits: if a later hook or commit
fails, preserve earlier commits and report their hashes and the remaining state.
Never reset history or overwrite concurrent edits. Do not claim that all actions
committed when only a prefix succeeded. Keep errors on stderr with no partial
success report on stdout, consistent with the current CLI error convention.

### Required examples

Initially B pins A@1.2.3, C declares ^1.2.0, both share one A@1.2.3 installation,
and A@1.2.5 is safe.

- PR 1: upgrade C's resolution to safe A while preserving B's valid pin. The
  finding is partial. npm may split or relocate installations.
- B@1.1.0 pins safe A: upgrade B first. If C also resolves safely, skip the A
  action and produce one commit. If npm retains vulnerable A for C, perform the
  residual A upgrade and produce two commits. Never assume automatic deduplication.
- B@1.1.0 removes A: upgrade B first, then upgrade A for C if it remains
  vulnerable. Normally this yields separate B and A commits. If C became safe
  during the B operation, skip the redundant action.

## Implementation boundaries

Keep distinct units for incoming-edge coverage, action selection, ancestor
discovery, read-only resolution, report rendering, transaction execution, graph
verification, and commit sequencing. Adapt the existing staging, Git, and recovery
modules rather than bypassing their guards. Avoid unrelated refactoring.

The existing ordered-strategy loop cannot stop at the first individually partial
strategy: accumulate complementary actions for uncovered consumers. Preserve
strategy preference while validating and deduplicating their joint effect.

## Verification and delivery

PR 1 must cover Markdown-only label changes before partial-remediation behavior;
schema version 3 validation; mixed exact/caret consumers; several target
locations; incompatible ranges; preserved pins; safe reuse and splitting;
location moves; multiple within-range actions; no-op handling; fresh security
failures; isolation and recovery; and commit sequencing when several upgrades
are performed. Do not infer vulnerability removal solely from a missing path.

PR 2 adds immediate-parent success without grandparent lookup; grandparent
fallback; no solution in two levels; independent shared-parent branches; parent
incoming constraints; dependency removal and indirect reintroduction; cycles;
metadata reuse; read-only planning; unchanged override policy; mixed-strategy
ordering; skipped redundant actions; combined verification; separate commits;
hook failures after an earlier commit; and concurrent-edit preservation.

Use real-npm local-registry E2E fixtures to establish resolution, splitting,
lockfile synchronization, and commits on the documented npm runtimes. Unit tests
alone cannot prove npm will produce the intended split. Run affected tool suites,
public CLI integration checks, and shared lint. Inspect changed help output.
Keep scratch fixtures and runtime provisioning under the user's designated tmp
directory using existing test overrides and TMPDIR as appropriate.

Each PR includes documentation and a final grouped version-bump commit for every
affected tool, once per tool relative to its PR base. Use minor bumps for new
capabilities under the repository policy, and Conventional Commit breaking-change
markers for incompatible public schema changes. The implementation plan must list
the intended commits and their contents before code changes. PR 2 builds on PR 1.

## Non-goals

No exhaustive ancestor search, user-configurable depth, search-status output,
choice-selection flag, competing action alternatives, legacy report migration,
out-of-range parent upgrade, new parent-strategy override, manual lockfile
patching, unrelated installation remediation, or automatic history reset.
