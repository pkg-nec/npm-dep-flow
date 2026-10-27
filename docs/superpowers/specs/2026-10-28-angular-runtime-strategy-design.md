# Angular runtime upgrade strategy

Date: 2026-10-28

## Intent and agreed constraints

PR #29 added `upgrade-angular-toolchain` for the exact-pinned `@angular/cli` / `@angular/build` pair. The same
webapp pins a second Angular line, the **runtime**, which the user migrates by hand with `nx migrate`. This feature
automates **patch-level (rarely minor)** runtime migrations the way PR #29 did for the toolchain. Design:
[2026-10-27-angular-toolchain-strategy-design.md](2026-10-27-angular-toolchain-strategy-design.md); this spec only
records what differs, plus the refactor that makes the two lines share code.

Runtime packages: `@angular/common`, `@angular/compiler`, `@angular/compiler-cli`, `@angular/core`,
`@angular/forms`, `@angular/platform-browser`, `@angular/router` (the root declares them in `dependencies`, and
`@angular/compiler-cli` in `devDependencies`). All move to one version. The lines migrate independently as long as
both keep the same major; major migrations stay manual and out of scope.

Agreed with the user:

- New strategy `upgrade-angular-runtime`, label `Upgrade Angular runtime`, behaving like the toolchain strategy:
  planner recommends the lowest same-major version that clears the uncovered branches (no release-age filter in the
  planner); the upgrade tool enforces the 7-day rule and the configured `before`.
- The release age and the catalog are read from `@angular/core` (not from each member).
- The upgrade tool runs `npx --no nx migrate @angular/core@<v>` and commits
  `deps({module}): bump Angular runtime to <v>` (description `bump Angular runtime to <v>`; with `--module webapp`
  the subject is `deps(webapp): bump Angular runtime to <v>`).
- An `@angular/platform-browser-dynamic` entry in `overrides` is **updated to the target if it exists** and left
  absent if it does not (same rule as the `@angular-devkit/core` override for the toolchain). In the user's webapp
  the entry is currently stale: no lockfile entry and no dependent.
- Allowlist for runtime: only the seven runtime members and the `@angular/platform-browser-dynamic` override may
  change after `nx migrate`, and every changed one must equal the target. Unlike toolchain there is no unchecked
  member. Any other package or version aborts and reverts.
- Everything else matches the toolchain strategy: clean tree including untracked files, `npm ci --ignore-scripts`
  with a sync check, `migrations.json` aborts, install plain → `-f` → plain, fresh audit, own commit, narrowed
  revert (restores the two dependency files only while they still hold what the run wrote, deletes
  `migrations.json`, leaves and names any other changed path), `npm_config_ignore_scripts=true` for the `nx`
  subprocess, Windows launches `.cmd` through a shell with the argument allowlist.
- When one finding carries several choices the planner evaluates the strategies in this order, each covering only
  what the earlier ones left uncovered: within-range, parent, toolchain, runtime. The upgrade tool executes them in
  the order: toolchain, runtime, parent, within-range.

## Commit order (agreed with the user)

The generalization of the toolchain code comes **first**, in behavior-preserving commits, before any commit that
introduces runtime behavior. Each refactor commit keeps every existing toolchain test passing with unchanged
assertions (tests may be renamed or parameterized but not weakened) and does not change JSON, Markdown, CLI or
error output for the toolchain strategy. Versions are bumped only in the last commit.

Refactor (no runtime behavior):

1. `refactor(upgrade-plan): drive the Angular toolchain strategy from a line config`
2. `refactor(upgrade-plan): make the scratch resolver and report line aware`
3. `refactor(upgrade): drive Angular toolchain validation from a line config`
4. `refactor(upgrade): run Angular line migrations as a list of pre-phases`

Feature:

5. `feat(upgrade-plan): plan Angular runtime upgrades`
6. `feat(upgrade): migrate the Angular runtime`
7. `test(upgrade): cover the Angular runtime end to end`
8. `docs: document the Angular runtime strategy`
9. `chore: bump upgrade-plan and upgrade versions` (minor bumps for both)

## Design

### Line config

Each of the two tools keeps its own copy (tools do not import each other's private code) of a small registry of
Angular lines. An entry holds: `strategy`, `label`, `members` (root-declared package names), `anchor` (the package
whose catalog, release time and `nx migrate` argument are used, and whose location is the choice's
`targetLocation`), `overrides` (override names updated only if present), `allowlist`, `unchecked` (allowlisted
packages whose version is not compared with the target; toolchain has `@angular-devkit/architect`, runtime has
none) and `description` (commit text). Two entries exist: `toolchain` (today's constants) and `runtime` (values in
this spec). Nothing in the code outside the registry names an Angular package.

### Planner (`npm-dep-upgrade-plan`)

- `toolchain.js` and `toolchain-planning.js` become line-parameterized (`angular-lines.js` holds the registry);
  `planToolchainChoices` becomes `planLineChoices(line, …)` with identical behavior for the toolchain line.
- Applicability for a line: the anchor is a root direct dependency (`dependencies` or `devDependencies`); each
  other member is a member only when the root declares it; every member must be installed and all members share one
  installed version; the vulnerable installation is a member or at most two levels below one.
- One choice per line per finding. The candidate search is the same: lowest same-major catalog version (anchor
  catalog) that keeps every existing choice, including a choice of the other line, and clears at least one
  uncovered in-scope branch. Choices passed to the resolver are ordered toolchain, runtime, parent, within-range.
- Scratch resolver: a choice of any line rewrites every member the root declares for that line to the exact target
  version in the field that declares it, updates that line's overrides only if they exist, and puts those members'
  closures in scope; other lines' members are not touched. The root-consumer coverage special case applies to the
  members of the choice's line. A misplaced line choice (not before parent and within-range choices) still fails
  the worker.
- Report: Markdown Strategy cell lists other labels, then parent transitions, then toolchain, then runtime
  transitions, e.g. `Upgrade Angular runtime: @angular/core@21.2.25 → @angular/core@21.2.26`. JSON choice fields are
  unchanged; schema version stays 3.

### Upgrade tool (`npm-dep-upgrade`)

- Validation accepts `upgrade-angular-runtime` with `targetPackage` equal to the line anchor, canonical anchor
  location, same major, upward version, non-empty consumers (root location allowed), and at most one choice per
  line. `splitToolchain` becomes `splitLines(item)` returning the line choices in execution order (toolchain, then
  runtime) and the rest.
- `migrateToolchain` becomes `migrateLine(line, …)` with the toolchain behavior and messages unchanged (messages
  use the line's name). The runtime line differs only in the registry values above.
- `cli.js` runs the line choices as a list of pre-phases. After each pre-phase it refreshes the guard, reloads the
  project and trims the remaining choices exactly as it does today after the toolchain; a failure keeps every earlier
  phase's commit and names it. Actions and commit `actionIndex` values follow the combined order.
- Release selection reuses `selectToolchainRelease` generalized to a line (planned release if still eligible,
  otherwise the lowest newer same-major stable release passing the age, `before` and advisory checks, by the
  anchor's publication time).

## Testing

- Refactor commits: the existing planner and upgrade suites, including the toolchain e2e scenarios, pass unchanged.
- Planner: runtime choice scenarios mirroring the toolchain ones (depth-1 and depth-2 child, vulnerable member
  itself with the root consumer, mixed with within-range and parent, not applicable for mixed member versions or a
  missing `@angular/core`, override updated only if present), a finding with both a toolchain and a runtime choice,
  report order, cache freshness from the `@angular/core` catalog.
- Upgrade: allowlist for runtime (the seven members and the override pass at the target; `@angular/cli` or an
  eighth package changing fails), the `@angular/platform-browser-dynamic` override present/absent, release age on
  `@angular/core`, both pre-phases in one run (two commits, toolchain first), failure of the second pre-phase keeps
  the first commit, revert scope, both Windows and Unix launch forms (the scripted runner decodes both).
- E2E: runtime scenarios beside the toolchain ones with a fake `nx` serving `migrate @angular/core@<v>` and a
  `migrations.json` variant.
- Lint with zero warnings; `--help` is unchanged.

## Documentation and release

- Update the planner and upgrade READMEs (second line, runtime allowlist, ordering) and the AGENTS.md lines.
- Bump `npm-dep-upgrade-plan` and `npm-dep-upgrade` as minor versions in the last commit.

## Out of scope

Major migrations, Angular packages outside the two lines (for example `@angular/animations`), and a user-configurable
line list.

## Open risk

Whether `nx migrate @angular/core@<v>` changes anything outside the runtime group (for example toolchain packages)
is only known from a real run. If it does, the allowlist aborts safely and the registry's allowlist is widened
deliberately.
