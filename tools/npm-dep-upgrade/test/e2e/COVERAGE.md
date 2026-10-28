# E2E coverage

The committed catalog and its final addendum define the inputs and expected behavior. Test names retain catalog IDs. All application cases invoke real tool executables, npm and Git; only the registry/security data and explicit faults are controlled. Unit tests supplement the actual resolver boundary.

| Catalog cases | Executable coverage |
| --- | --- |
| D01 | `direct.test.js`: all four sections × caret/tilde; `harness.test.js`: full stack and clean ci |
| D02 | `direct.test.js`: caret versus tilde upper bounds |
| D03, D04 | `ineligible.test.js`: exact/shared-exact refusal; `direct.test.js`: compatible duplicate declarations |
| T01 | `transitive.test.js`: all four parent sections × child caret/tilde, original manifest bytes |
| T02, T03 | `transitive.test.js`: transitive parent and two parent versions |
| Scoped override metadata regression | `transitive.test.js`: a compatible nested child upgrades when npm reports selector metadata on the incoming parent edge; the parent version remains unchanged |
| T04 | `transitive.test.js`: asserts repeated-parent topology and eligible versus pinned shared consumer; narrow scope or safe refusal |
| T05 | `transitive.test.js`: one shared installation, caret/tilde incoming consumers |
| T06, T08 | `ineligible.test.js`: shared exact pin / sole exact pin refusal |
| T07 | `transitive.test.js`: separate eligible and pinned copies, root7 unchanged, remaining finding; `ineligible.test.js`: pinned selector |
| T09 regression | `transitive.test.js`: 25 package nodes with 2,048 ancestry routes upgrade through an immediate-parent scope, remove the temporary override, and reproduce the committed lockfile |
| O01, O02 | `transitive.test.js`: original override bytes retained; `ineligible.test.js`: conflicting policy |
| O03 | `compatibility.test.js` / `runner.js`: real npm12/11 EOVERRIDE without dot or with conflicting dot, followed by successful approved rule |
| O04 | `recovery.test.js`: real cleanup install followed by deterministic reverted-result injection |
| R01, R03, R04 A/C | `supporting.test.js`: newest safe, missing/invalid newest timestamps with fallback, independent snapshots |
| R02, R03 no fallback, R04 B | `security.test.js`: too young, missing/invalid all safe times, no age-eligible safe candidate |
| R05, G05 | `security.test.js`: explicit post-selection install checkpoint changes advisory snapshot; stale, recovery, no retry/commit |
| R06 | `transitive.test.js` / `ids.test.js`: scoped names, parent reference, exact-name filter |
| F01 | `security.test.js`: unavailable metadata, candidate advisory unavailable/malformed; candidate-only advisory exclusion |
| F02 | `recovery.test.js`: unavailable/corrupt tarball, real peer conflict |
| F03 amended, G01 | `git.test.js`: dirty/staged manifest/lock, unrelated staged file, missing/untracked lock; preserves all input bytes/index |
| F04 amended | `ineligible.test.js`: clean project / unsupported row selected explicitly |
| F05 amended | `recovery.test.js`: same ID again after direct/transitive success, no second commit |
| F06 | `harness.test.js`, `supporting.test.js`, `runner.js`: actual tarballs, lifecycle sentinels, installed resolution and separate clean npm ci |
| H01 | `ids.test.js`: full deterministic hashes, Markdown prefixes, different absolute roots; planner `ids.test.js`: version-independent identity |
| H02 | `ids.test.js`: 7/12/64-character selectors, full plus package, scoped filter |
| H03, H04 | `ids.test.js`: frozen genuine SHA256 seven-character collisions across packages / same-package locations; no hash stub |
| H05 | `ineligible.test.js`: CLI controls; `test/planner.test.js`: missing/mismatched/duplicate full IDs, unsupported strategy, failed/malformed planner, hypothetical full collision |
| G02, G03 | `git.test.js`: nested paths with spaces/shell symbols, unrelated tracked/untracked work; `runner.js`: exact commit count/subject/hash/files/content |
| G04 | `recovery.test.js`: initial/cleanup phase failures and unexpected result; restores owned dependency bytes, warns about node_modules |
| G06 | `git.test.js`: missing identity, detached HEAD, in-progress operation, rejecting real commit hook retaining verified files |
| G07 | `git.test.js`: explicit checkpoint user edit, staged file, HEAD movement preserved; unit recovery rejects concurrent edits |
| S01, S02 | `supporting.test.js`: helper2→3 required upgrade, other target copies and unrelated package retained; unit verifier covers supporting add/remove/shared consumers |
| S03 | `security.test.js`: newly vulnerable helper blocks commit and recovers files |

`compatibility.test.js` repeats D01 caret/tilde, T01/T02/T05/T06/T07, O01/O03, R01/R02/R05, F05/F06, H02, G03 and S01 on exactly npm11.10.0. It also repeats D01/T01/T05/F06 with lockfile v2 and D01/T01/T07 without initial node_modules. Default cases use exactly npm12.1.0; fixture time values are generous relative ages, while unit candidate tests freeze exact seven-day boundaries. Registry calls and unknown-request handling are checked by the harness; every case isolates cache/config/identity/hooks/scratch. Windows CI runs real D01/T01/O03/F06 paths. A Linux-only local run does not prove Windows checks passed.

Independent-review regressions are in `review.test.js`: concurrent top-level lock metadata is preserved without committing, invalid private resolver output leaves original dependency files untouched, inconsistent v2 legacy data is rejected, and stable build-metadata releases retain exact identity. Unit Git tests additionally cover same-HEAD branch switches, clean CRLF normalization, and successful pre-commit/message hooks attempting to consume unrelated work or change the required subject. Private-stage configuration has its own adapter test.

`project-location.test.js` covers absolute and relative project arguments for direct and transitive upgrades from a separate caller repository. It verifies nested target paths with spaces/shell symbols, preserves caller dependency edits/staged work/HEAD, and checks target commit contents plus clean reproduction. These cases also run in the Windows smoke workflow.

`test/scopes.test.js` exercises the real paths CLI and Arborist scope probe. It covers the compact ancestry regression, same-version location filtering, repeated parent versions requiring ancestor scopes, multiple physical heads sharing one selector, cyclic ancestry refusal, and incomplete/conflicting direct-dependent evidence.

Explicit JSON configuration: `config.test.js` exercises nested-project selection from another caller directory through the real sibling CLI chain, config-driven debug propagation, custom commit subjects, and `--no-verify` with rejecting user hooks. Unit Git tests cover prepare-commit-msg guards under `--no-verify`.

## Partial remediation (schema 3)

`partial.test.js` runs on both configured npm runtimes. One and four exact/caret consumer pairs verify one grouped safe action, preserved pins, unchanged final manifest bytes, a remaining `none` finding, and clean-ci reproduction. Disjoint safe ranges verify two actions and two ordered commits for one original installation. `commit-sequence.test.js` verifies per-snapshot commit contents and preservation of an earlier commit when a later hook rejects.

Planner and upgrade output use schema version 3; audit/paths/versions remain version 2. T06 is now a partial success rather than an all-consumer eligibility failure.

## Parent upgrades

`parents.test.js` runs on both configured npm runtimes against real planner, paths, audit, versions and upgrade executables:

| Behavior | Case |
| --- | --- |
| Parent pins the safe version; other consumer pinned | one parent commit, `partial`, no override; only the parent's own root range is raised |
| Direct parent range | a root `^` parent (dependencies or devDependencies) is raised to the installed release in `package.json` and the lockfile root, `npm ci` clean; a wider declaration such as `>=1.0.0` is upgraded and left as written |
| Parent pins the safe version; npm dedupes upward | plan lists within-range and parent actions, executor skips the child (`already-satisfied`), one commit, `complete` |
| Parent removes the dependency | residual consumer upgraded in a second commit; each commit independently `npm ci` clean; or one commit when the other consumer is pinned (`partial`) |
| Immediate parent succeeds | planner debug log shows no grandparent catalog request |
| Grandparent fallback | immediate parent pinned by the grandparent; grandparent upgrade clears the branch |
| Level three | a safe release three levels up is never evaluated: `none`, no third-level request, executor refuses |
| No solution | no safe release anywhere: `none` |
| Shared grandparent | two children freed by one grandparent release become one action and one commit |
| Indirect reintroduction | a descendant bringing the affected version back is not claimed safe |
| Incoming declaration | another consumer's declaration excludes the parent release |
| Scope conflict | a named update that would also move another copy of the ancestor is rejected |
| Second-commit hook failure | first commit kept, hash and remaining state reported, outside edit preserved |
| Fresh security | a candidate that became vulnerable, or too young, after planning is refused before any commit; a vulnerable planned release falls forward to the next eligible one |
| Loosened pin | an ancestor that turns an exact pin into a caret is followed by a within-range action on the new declaration: two commits, `complete`, no overrides; an ancestor that keeps the pin offers nothing |
| Supporting advisories | replacing an affected supporting version with one carrying the same advisories is accepted; gaining an advisory is refused before any commit |
| Release-age policy | what a parent release brings in resolves to the newest release old enough under a 7-day and a 30-day `min-release-age`; a parent release younger than the policy is never planned |

Resolver-level cases (removal, reintroduction, exact-version landing, dedupe, grandparent) also run against real npm in the planner's `resolver-parent.integration.test.js`.

## Angular toolchain migrations

`toolchain.test.js` runs on both configured npm runtimes against the real planner, paths, audit, versions and upgrade executables. The fixture has the webapp's shape: exact-pinned `@angular/cli` and `@angular/build` in `devDependencies`, an `@angular-devkit/core` override, and a vulnerable package two levels below `@angular/build` that the next toolchain patch fixes. A fake `nx` package from the local registry is installed in the project. Its `migrate @angular/cli@<v>` bin rewrites the two members in `package.json`, and in one variant it also writes `migrations.json`. `npx` comes from the same pinned npm runtime.

| Behavior | Case |
| --- | --- |
| Planning | exact pins do not block the strategy; the finding is `complete` with a single `upgrade-angular-toolchain` choice for `@angular/cli` that clears the depth-two consumer |
| Migration | exit 0, one commit `deps: migrate Angular toolchain to <v>` holding only `package.json` and `package-lock.json`; both members and the override at `<v>`; clean tree; separate clean `npm ci` reproduces the tree; the finding is gone on replanning |
| Module scope | `--module webapp` gives `deps(webapp): migrate Angular toolchain to <v>` |
| `migrations.json` | exit 1 with the dedicated diagnostic, `git status --porcelain` empty (the generated file is removed), HEAD and dependency bytes unchanged |
| Release age | a target whose `@angular/cli` release becomes younger than seven days after planning: exit 1, no change |
| Mixed choices | toolchain plus within-range for one finding: two commits, toolchain first, then within-range; `complete` |

## Angular runtime migrations

`runtime.test.js` runs on both configured npm runtimes against the real planner, paths, audit, versions and upgrade executables. The fixture has the webapp's shape: the seven exact-pinned runtime members (`@angular/compiler-cli` in `devDependencies`, the rest in `dependencies`) beside the exact-pinned toolchain pair, an `@angular-devkit/core` override and a stale `@angular/platform-browser-dynamic` override (no lockfile entry, nothing depends on it). The packages carry the real Angular 20 peer shape: runtime members peer on exact versions of each other, `@angular/compiler-cli` also on `typescript`, and `@angular/build` peers on `^` ranges of the runtime. With that shape, real npm refuses the plain install after `nx migrate` with `ERESOLVE`, so every runtime migration goes through the executor's plain, `-f`, plain install sequence. A vulnerable package sits two levels below `@angular/core` and is fixed by the next runtime patch. The fake `nx` (`helpers/nx.js`, shared with `toolchain.test.js`) rewrites the root-declared members of the line its package argument names (`@angular/cli` or `@angular/core`) to the exact version (that real nx does the same for a member declared with a range is an unverified assumption), and leaves `overrides` alone; variants also set the line's overrides, keep a `^` operator, move further packages, or write `migrations.json`.

| Behavior | Case |
| --- | --- |
| Planning | the finding is `complete` with a single `upgrade-angular-runtime` choice for `@angular/core` that clears the depth-two consumer; the Markdown Strategy cell names the runtime transition |
| Migration | exit 0, one commit `deps: bump Angular runtime to <v>` holding only `package.json` and `package-lock.json`; the `--debug` process log shows `npm ci`, a failing plain install, the `-f` install and the final plain install; npm's `ERESOLVE` is relayed; the seven members in their own fields, the stale override and the lockfile members all at `<v>`, the toolchain and its override unchanged, no `@angular/platform-browser-dynamic` installed; clean tree; separate clean `npm ci` reproduces the tree; the finding is gone on replanning |
| Module scope | `--module webapp` gives `deps(webapp): bump Angular runtime to <v>` |
| Overrides | an nx that also sets the override is accepted; without the override none is added |
| `^` member | a member declared `^<current>` is pinned to `<v>`, the exact version the fixture nx writes (real nx behavior unverified); an nx that keeps the operator is refused (`must be <v>`) and reverted |
| `migrations.json` | exit 1 with the dedicated diagnostic, `git status --porcelain` empty, HEAD and dependency bytes unchanged |
| Release age | an `@angular/core` release that becomes younger than seven days after planning: exit 1, no change |
| Allowlist | an nx that also moves `@angular/cli` during the runtime migration: exit 1 with `Unexpected change to @angular/cli`, working tree restored, no commit |
| Both lines | one finding reached through `@angular/build` and `@angular/core`: toolchain and runtime choices, two commits (toolchain first, holding only the toolchain move; then runtime), the toolchain installs plainly and the runtime through `-f`; `complete`, clean `npm ci` reproduction |
