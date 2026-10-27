# Angular toolchain upgrade strategy

Date: 2026-10-27

## Intent and agreed constraints

The user's Angular webapp pins its toolchain packages to exact versions: `@angular/cli` and `@angular/build`
in `devDependencies`, plus an `@angular-devkit/core` entry in `overrides`. The existing strategies cannot move them:
within-range cannot cross an exact pin, and the parent strategy never upgrades the project root. The user migrates
the toolchain by hand with `nx migrate`. This feature automates **patch-level (rarely minor)** toolchain migrations.

Out of scope: major migrations (manual), the Angular **runtime** line (`@angular/core`, `common`, `compiler`,
`forms`, `platform-browser`, `router`, `compiler-cli`, and the `@angular/platform-browser-dynamic` override), and any
other package manager or monorepo layout.

Agreed with the user:

- New strategy `upgrade-angular-toolchain`, evaluated **after** `update-within-declared-range` and
  `upgrade-via-parent-dependency`, covering only the consumer branches those left uncovered (like parent upgrades).
- Trigger: the vulnerable installation is `@angular/cli`, `@angular/build`, or sits at most two levels below either,
  and a same-major bump of the pair clears the uncovered branches.
- Target: the lowest same-major version that clears them. The **planner applies no release-age filter** (like the
  two existing strategies); the **upgrade tool enforces the 7-day rule**, checking only `@angular/cli`'s publication
  time (the other packages share the version).
- Clearing is decided like the parent strategy: the planner's read-only resolver in a scratch project.
- Exact pins do not block the strategy.
- When one finding has several choices, the upgrade tool executes **toolchain first, then parent, then
  within-range** (own package).
- Install step: plain `npm install --ignore-scripts`, fallback to `-f` on failure, then plain again, which must pass.

## Planner (`npm-dep-upgrade-plan`)

- Add strategy id `upgrade-angular-toolchain`, label "Upgrade Angular toolchain", ordered third.
- Applicability, all required:
  - `@angular/cli` is a root direct dependency; `@angular/build` too if present.
  - All present members share one current version.
  - The vulnerable installation is a member or within two ancestor levels beneath one (from the existing
    `npm-dep-paths --upstream-of` answer).
- Candidates come from the `npm-dep-versions` catalog of `@angular/cli`: stable, newer, same major as current.
  The lowest candidate for which the resolver, with every member set to that version (and the
  `@angular-devkit/core` override too if present), clears the uncovered branches wins. Extend the scratch resolver
  to edit root declarations; parent strategies never needed this.
- The choice uses schema 3 fields: `targetPackage: "@angular/cli"`, its `targetLocation`, `currentVersion`,
  `targetVersion`, and `affectedConsumers` for the branches cleared. A finding may combine this choice with
  within-range and parent choices; the action set is resolved together. Schema version stays 3 (additive value);
  planner and upgrade are released together.
- Cache keys, TTL and freshness follow the parent strategy (earliest catalog/audit source wins).

## Executor (`npm-dep-upgrade`)

- Validation accepts the new strategy value. Choices execute in order: toolchain, parent, within-range.
- Re-selection: read fresh catalogs and candidate advisories, then pick the lowest same-major `@angular/cli`
  version that clears the finding **and** is at least seven days old (and satisfies the configured `before`). If none
  qualifies, fail with no change, as the parent re-selection does.
- Flow, in the real project (`nx migrate` needs the workspace):
  1. Require a completely clean working tree (no staged, unstaged or untracked changes).
  2. `npm ci --ignore-scripts`; verify package.json and package-lock.json are in sync.
  3. `npx nx migrate @angular/cli@<v>`. If `migrations.json` appears, abort and revert.
  4. Check the package.json diff against the allowlist.
  5. Set the `@angular-devkit/core` override to `<v>`, only if the override exists.
  6. `npm install --ignore-scripts`; on failure retry with `-f`; then run plain again, which must succeed.
  7. Fresh audit: the finding's branches are cleared and no new advisory appears.
  8. Stage package.json and package-lock.json only; commit `deps({module}): migrate Angular toolchain to <v>`
     (the existing `deps({module}): {description}` template, or the configured template).
- Allowlist: only `@angular/cli`, `@angular/build`, `@angular-devkit/core`, `@angular-devkit/schematics`,
  `@schematics/angular`, `@angular-devkit/architect` may change. All except `@angular-devkit/architect` that
  change must equal `<v>`; architect's version is **not checked** (its scheme may change). Any other package or
  version aborts and reverts.
- One commit per action as today; the toolchain commit is first, followed by commits for the other actions.
- Failure at any step: restore tracked files, delete untracked files the run created (including `migrations.json`),
  print stderr diagnostics, exit 1, no partial report. `node_modules` stays (ignored). A later failure keeps
  earlier committed actions.

## Testing

- Planner: exact-pinned pair clearing a depth-1 and a depth-2 child; combined with a within-range choice; not
  applicable when member versions differ, `@angular/cli` is not a root dependency, or the major would change;
  JSON and Markdown output; cache freshness.
- Upgrade: each abort path (dirty tree, out-of-sync lock, `migrations.json`, off-allowlist change, wrong version,
  target younger than seven days, install failing even with `-f`) and its revert; the `-f` fallback; execution
  order with mixed choices; commit message. E2E extends the existing local-registry cases with a fake `nx`.
- Run `--help` checks for changed text, shared lint with zero warnings, and the affected tool tests.

## Documentation and release

- Update the planner and upgrade READMEs (strategy list, flow, allowlist, ordering).
- Bump `npm-dep-upgrade-plan` and `npm-dep-upgrade` as minor versions, with lockfile metadata, in the final commit.

## Planned commits

1. `docs: add Angular toolchain strategy design` (this spec).
2. `feat(upgrade-plan): add Angular toolchain upgrade strategy`.
3. `feat(upgrade): migrate the Angular toolchain`.
4. `docs: document the Angular toolchain strategy`.
5. `chore: bump upgrade-plan and upgrade versions`.
