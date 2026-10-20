# Dependency upgrade E2E cases — review draft

Date: 2026-10-20

This is a reviewable test-case draft, not an implementation plan or a claim that these tests already exist. Case IDs are stable so review comments can refer to individual cases.

## Agreed scope

- Only `update-within-declared-range` is supported. No parent upgrades, forced incompatible upgrades, or additional remediation strategies.
- Direct dependencies with caret or tilde requirements preserve their operator and dependency section: `^6.0.8` becomes `^6.0.12`; `~6.0.8` becomes `~6.0.12`.
- Exact-pinned direct dependencies are excluded.
- Select the newest stable, non-vulnerable, old-enough candidate satisfying every original incoming requirement for the target installation. The planner's current minimum candidate must not accidentally become a newest-version selection policy.
- Default npm version: exactly **12.1.0**. Use explicitly provisioned npm executables; do not replace the developer's global npm installation.
- Compatibility version: exactly **11.10.0**. Compatibility failures are reported, not silently skipped or handled by changing expectations to accept incorrect results.
- Minimum release age for these cases: seven days.
- Use the approved version-qualified parent scope for transitive updates. When the parent is a direct dependency, preserve its specification with a reference:

  ```json
  {
    "overrides": {
      "e2e-parent-a@1.2.4": {
        ".": "$e2e-parent-a",
        "e2e-target": "^6.0.12"
      }
    }
  }
  ```

- Remove operation-created overrides when the upgraded resolution survives without them. Do not keep a redundant override as part of a successful result.
- Preserve the upgraded lockfile during cleanup. Do not use `git restore package-lock.json`.
- If advisory data makes the selected recommendation stale, report that condition and require a fresh planning run. Do not silently select another version during application.

The final CLI name, flags, and whether application is built into the tool remain separate design decisions. In these cases, **apply** means carrying out the proposed manifest edits and npm commands, either through the tool or through a test driver executing its output.

## Controlled environment

Use the real new CLI, planner, audit CLI, paths CLI, and pinned npm. Fake the external registry and its advisory service, rather than replacing the npm resolver or returning canned sibling-tool reports in the main E2E suite.

The local registry provides package metadata, publication times, minimal package tarballs, integrity values, and responses to npm's advisory requests. Advisory responses must be based on the submitted package names and versions. Support each audit endpoint used by the pinned npm versions; fail unexpected requests and prevent fallback to public services.

Each case has an isolated project, npm cache, audit cache, and npm configuration. Override user/global registry, scoped registry, audit registry, and release-age configuration so host settings cannot change results. All fixture state, logs, caches, and installed packages belong under `/home/maw/src/nrc/npm-dep-flow-impl/tmp/`.

Run the default suite on npm 12.1.0 with lockfile version 3. Additional version/platform variants are listed later; avoid an unnecessary full Cartesian product.

### Package catalog

These are invented package names. They are served only by the local registry; the tests must never look them up publicly.

| Package | Purpose |
| --- | --- |
| `e2e-app@1.0.0` | Root fixture project. |
| `e2e-target` | Vulnerable package being updated. |
| `e2e-parent-a@1.2.4` | Parent normally requiring `e2e-target@^6.0.8`. |
| `e2e-parent-a@1.3.0` | Second parent version used to test selector scope. |
| `e2e-parent-b@2.0.0` | Another parent; its child requirement varies by case. |
| `e2e-ancestor@3.0.0` | Extra ancestry for repeated-parent scoping cases. |
| `e2e-unrelated@4.0.0` | Package whose requirements and resolution must be preserved. |
| `@e2e/parent`, `@e2e/target` | Scoped-name equivalents for request encoding and override syntax. |

### Default target versions

Capture one reference time `T` at case setup and generate timestamps from it. Use large margins for npm subprocess tests; exact age-boundary checks belong in controlled-clock unit tests.

| Version | Published | Advisory snapshot A | Purpose |
| --- | --- | --- | --- |
| `6.0.9` | `T - 60 days` | Vulnerable | Initially locked version. |
| `6.0.10` | `T - 40 days` | Safe | Older eligible fix; proves selection is not simply the minimum fix. |
| `6.0.12` | `T - 30 days` | Safe | Expected selection in the baseline. |
| `6.0.13` | `T - 1 day` | Safe | Newer but too young. |
| `6.0.14-beta.1` | `T - 30 days` | Safe | Prerelease, excluded. |
| `6.1.0` | `T - 1 day` | Safe | Minor candidate made old only in range-boundary cases. |
| `7.0.5` | `T - 30 days` | Safe | Outside the baseline caret and tilde ranges. |

Snapshot A marks versions `<6.0.10` vulnerable. Cases that use different advisory ranges or publication times state the change explicitly. Each case starts with its specified old resolution, even though newer versions are available when the tool runs. Build initial locks against a reduced catalog, then expose the complete catalog; do not accidentally install the fix during fixture setup.

## Common assertions

For every successful application:

1. Check the final manifest requirements, operators, dependency sections, and override cleanup.
2. Check lockfile versions and root manifest metadata for consistency.
3. Check resolution from each relevant parent, including nested copies. Do not assume a top-level copy proves every branch was fixed.
4. Confirm selected versions satisfy the original incoming requirements, are stable, and pass the age policy.
5. Run fresh audit verification with no cached pre-change report. Assert the targeted findings are gone; explicitly allowed ineligible findings may remain.
6. Check that unrelated requirements, parent versions, overrides, and package resolutions remain correct. Do not demand identical lockfile formatting across npm versions.
7. In a fresh project directory, use the final manifest and lockfile with `npm ci --ignore-scripts` against the fixture registry. Confirm the affected branches resolve to the expected versions without temporary overrides.
8. Verify lifecycle-script sentinels were not created.

For ineligible cases, assert the target is reported as skipped/ineligible and its files are unchanged. A mixed eligible/ineligible case may change the project for its eligible targets, but must not report all findings as resolved.

## Direct dependency cases

### D01 — Preserve range operator and dependency section

**Setup:** Root requires `e2e-target` as `^6.0.8` or `~6.0.8`, locked at `6.0.9`. Use the default catalog and snapshot A.

**Variants:** Run both operators in each of `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`: eight variants. The optional package is installable on the test platform; the peer case has no conflicting peer provider.

**Action:** Plan and apply.

**Expect:** Select and install `6.0.12`. Final requirement is respectively `^6.0.12` or `~6.0.12` in the original section. Do not add the package to another section or create an override. Run the common success assertions.

### D02 — Respect caret and tilde upper bounds

**Setup:** Make `6.1.0` old enough. Keep `7.0.5` old enough.

**Variants:** Root requirement `^6.0.8`; root requirement `~6.0.8`.

**Expect:** Caret selects `6.1.0` and becomes `^6.1.0`. Tilde selects `6.0.12` and becomes `~6.0.12`. Neither selects `7.0.5`.

### D03 — Exact direct pin is excluded

**Setup:** Root requires exact `e2e-target@6.0.9`.

**Expect:** Report it outside the supported application scope. Do not change the requirement, lockfile, or overrides. The advisory remains visible; do not claim remediation.

### D04 — Multiple direct declarations

**Setup:** The root declares `e2e-target` in `devDependencies` and `peerDependencies`.

**Variants:** Compatible `~6.0.8` and `^6.0.8`; incompatible exact `6.0.9` and `^6.0.8`.

**Proposed expectation for review:** In the compatible variant, update both declarations to their respective operator plus `6.0.12`. In the exact-pin variant, skip the shared installation rather than change only one declaration or force past the exact pin.

## Transitive dependency cases

### T01 — Direct parent, temporary override, successful cleanup

**Setup:** Root requires `e2e-parent-a@^1.2.0`, locked at `1.2.4`. Its child requirement is `e2e-target@^6.0.8`, locked at `6.0.9`. Also publish a newer parent version, so an accidental parent upgrade is detectable.

**Action:** Apply using the approved `e2e-parent-a@1.2.4` scope and `".": "$e2e-parent-a"`; install, remove the introduced override, and install again.

**Expect:** No `EOVERRIDE`. Parent remains at `1.2.4`; root parent requirement stays `^1.2.0`. Target becomes `6.0.12` and stays there after cleanup. Final manifest has no operation-created override or empty `overrides` object. Parent's published child requirement remains unchanged.

**Variants:** Also run with child requirement `~6.0.8`. Exercise a direct parent in each of the four dependency sections on npm 12.1.0.

### T02 — Parent is itself transitive

**Setup:** `e2e-app -> e2e-ancestor -> e2e-parent-a@1.2.4 -> e2e-target@6.0.9`; the final edge allows `^6.0.8`.

**Expect:** Use a version-qualified parent scope without a root-dependency `$` reference that does not exist. Upgrade only the eligible target, remove the temporary rule, and retain the corrected resolution. No ancestor or parent upgrades.

### T03 — More than one parent version

**Setup:** Install `e2e-parent-a@1.2.4` and `e2e-parent-a@1.3.0` through separate branches. Version `1.2.4` has the eligible target; version `1.3.0` has an unrelated `e2e-target@7.0.5` branch.

**Expect:** Upgrade the eligible 6.x installation to `6.0.12`; leave the 7.x branch and both parent versions unchanged. Inspect the actual selector impact rather than assuming the key denotes a unique lockfile location.

### T04 — Repeated same-name/same-version parent

**Setup:** Two ancestor branches contain `e2e-parent-a@1.2.4`, with separate target installations. In one branch, an additional consumer requires exact `e2e-target@6.0.9` and resolves to the same installation as that branch's parent A. That target has both a caret and an exact incoming requirement; the other target has only compatible incoming requirements.

**Expect:** Narrow scope by ancestry when representable. Do not use a broad rule that temporarily modifies the ineligible branch. If the intended scope cannot be expressed safely, report that target as unsupported for automatic application; do not claim success.

### T05 — Shared target, all incoming ranges compatible

**Setup:** Parents A and B share one physical `e2e-target@6.0.9`. Requirements are `^6.0.8` and `~6.0.8`.

**Expect:** Upgrade the shared target to `6.0.12`, satisfying both original requirements. Both parents resolve the fixed version after cleanup and a fresh install.

### T06 — Shared target, one incoming exact pin

**Setup:** A and B share `e2e-target@6.0.9`; A requires `^6.0.8`, B requires exact `6.0.9`.

**Expect:** The shared installation is ineligible. No temporary global `e2e-target@6.0.9` override, forced upgrade, parent upgrade, or automatic graph splitting. Files remain unchanged.

### T07 — Separate eligible and ineligible target installations

**Setup:** Root already uses safe `e2e-target@7.0.5` through `^7.0.0`. Parents A and B therefore have separate nested copies of `e2e-target@6.0.9`; A requires `^6.0.8`, B requires exact `6.0.9`. Verify this topology before running the tool; root's 7.x copy must remain unchanged.

**Expect:** Upgrade the eligible copy to `6.0.12`; preserve the pinned copy. Final verification identifies the remaining ineligible finding instead of declaring the whole project vulnerability-free.

### T08 — Exact transitive pin, no eligible strategy

**Setup:** A sole parent requires exact `e2e-target@6.0.9`.

**Expect:** Ineligible and unchanged. Do not upgrade the parent or leave a permanent override to bypass its published requirement.

## Override preservation and npm compatibility

### O01 — Merge into an existing override object

**Setup:** Existing overrides include an unrelated entry and a parent object with a valid existing `"."` value plus a different child override.

**Action:** Add the temporary target rule, apply, and remove it.

**Expect:** Preserve unrelated keys, values, and override ordering where possible. Preserve the existing `"."` value. Remove only introduced entries and containers, not the pre-existing `overrides` section. If a temporary edit changes an existing value, restore its original value after use.

### O02 — Existing override conflicts with the proposed target

**Setup:** An existing override deliberately constrains the target to a range excluding `6.0.12`.

**Proposed expectation for review:** Report the conflict before application. Do not silently overwrite user policy, and do not treat removal of that policy as part of ordinary temporary-rule cleanup.

### O03 — Distinguish valid scope from direct-parent conflict

**Setup:** Root dependency is `e2e-parent-a@^1.2.0`.

**Diagnostic controls:** With real npm, verify that the version-qualified child rule without `"."` produces `EOVERRIDE`, while the approved form with `".": "$e2e-parent-a"` succeeds. Also confirm a conflicting explicit `"."` value is rejected. Controls run in separate fixture copies, not through the tool's normal success path.

**Tool expectation:** Emit/use the approved form; do not alter the parent's direct requirement to avoid the error.

**Versions:** Run on both npm 12.1.0 and 11.10.0.

### O04 — Cleanup does not preserve the selected upgrade

**Setup:** Use a controlled install-failure/incorrect-result fixture that causes the cleanup install to revert the target or leave an invalid graph. Keep this separate from the ordinary exact-pin cases, which must be rejected before application.

**Expect:** Detect the unexpected cleanup result, report failure, and do not silently retain the temporary override or claim remediation. Exact recovery behavior is covered by F03 below.

## Registry, advisory, and selection cases

### R01 — Newest eligible version, not minimum safe version

**Setup:** Use the default catalog: both `6.0.10` and `6.0.12` are safe and old enough; later stable releases are too young or outside the range.

**Expect:** Select `6.0.12`, not the planner's minimum safe `6.0.10`, not too-young `6.0.13`, not a prerelease, and not `7.0.5`.

### R02 — Safe fix exists, but none is old enough

**Setup:** All safe in-range versions were published one day before `T`.

**Expect:** No eligible application candidate. Explain that the age policy prevents the fix; do not choose a vulnerable older version, relax the policy, or cross the declared range.

### R03 — Missing or invalid release timestamp

**Setup:** The newest otherwise eligible candidate has a missing timestamp in one variant and an invalid timestamp in another. An older safe candidate has a valid old timestamp.

**Proposed expectation for review:** Exclude the unverifiable candidate and select the older verifiably eligible candidate. If no such candidate exists, leave unresolved. Do not interpret missing metadata as proof of sufficient age.

### R04 — Advisory snapshot changes the expected safe version

**Setup:** Run three independent fixture variants. Snapshot A marks `<6.0.10` vulnerable; snapshot B adds an advisory affecting `>=6.0.10 <=6.0.12`.

| Variant | Advisory data | Release times | Expected result |
| --- | --- | --- | --- |
| A | Snapshot A | Default catalog | Select `6.0.12`. |
| B | Snapshot B | Default catalog; `6.0.13` still too young | No eligible fix; do not reuse snapshot A's safe-version assumption. |
| C | Snapshot B | Make `6.0.13` old enough | Select `6.0.13`. |

Both advisory snapshots and release times are explicit fixture inputs; no public advisory changes affect the outcome. If `6.0.13` were already safe, available, and old enough under snapshot A, newest-version selection would choose it there too. The tests must not incorrectly expect the minimum safe `6.0.12` in that situation.

### R05 — Recommendation becomes stale during application

**Setup:** Plan against snapshot A and the baseline catalog; select `6.0.12`. At a controlled phase boundary after selection, switch to snapshot B, which additionally marks `6.0.12` vulnerable. Expose an old-enough safe `6.0.13` as an alternative.

**Expect:** Fresh verification detects the new advisory. Report a stale recommendation and require a new planning run. Do not report success, use a cached snapshot-A result, silently switch to `6.0.13`, or repeat indefinitely. Failure recovery must not pretend that rolling files back removes the new advisory.

**Harness requirement:** Trigger the snapshot change using an explicit phase/request checkpoint, not a timing sleep.

### R06 — Scoped package names

**Setup:** Repeat the direct-parent transitive flow with `@e2e/parent` and `@e2e/target`.

**Expect:** Correct registry URL encoding and package identity. Use the corresponding scoped override key and `$` reference; update the correct installation and clean up successfully.

## Failure and repeatability cases

### F01 — Registry or advisory service fails before application

**Variants:** Metadata request fails; advisory request fails; advisory response is malformed.

**Expect:** Clear error, no project changes, no partial success report, no fallback to the public registry. A failed advisory request is not equivalent to no vulnerabilities.

### F02 — Installation fails during application

**Variants:** Tarball unavailable; integrity mismatch; deterministic peer-resolution conflict.

**Expect:** Report failure and identify the affected stage. Never claim the target was fixed just because the manifest changed. Verify the chosen recovery contract from F03.

### F03 — Preserve user edits during recovery

**Setup:** Before application, the project has uncommitted manifest and lockfile edits unrelated to the target. Fail once during the initial install and once during the cleanup install in separate variants.

**Proposed expectation for review:** Restore manifest and lockfile to their captured pre-application contents, including the user's existing edits. Never use a blanket Git restore. Report whether `node_modules` may have changed; do not claim it was restored unless it was rebuilt and verified. The same recovery rule should cover stale recommendations and failed cleanup validation.

### F04 — No findings, or no eligible targets

**Variants:** Clean audit; only exact-pinned or otherwise ineligible targets.

**Expect:** No mutation commands and no manifest/lockfile changes. Distinguish a clean project from unresolved findings with no supported remedy.

### F05 — Idempotency

**Setup:** Complete D01 or T01 successfully; run the workflow again with unchanged registry/advisory data.

**Expect:** No further manifest or lockfile changes, no new overrides, and no unnecessary install cycle. The second report explains that no further supported remediation is needed.

### F06 — Real installation and clean reproduction

**Setup:** Use actual fixture tarballs, including harmless modules and lifecycle scripts that would create sentinel files if executed.

**Expect:** Install with lifecycle scripts disabled. Verify installed versions through parent-relative resolution, then verify a separate clean `npm ci --ignore-scripts`. No script sentinel exists in either project. Lockfile-only resolution checks supplement these tests; they do not replace them.

## Execution matrix

| Dimension | Proposed coverage |
| --- | --- |
| Default runtime | npm 12.1.0 for every case. Pin and record a compatible Node.js runtime in the harness. |
| Compatibility runtime | npm 11.10.0 for D01 caret/tilde in dependencies, T01, T02, T05–T07, O01, O03, R01–R02, R05, and F05–F06. |
| Lockfile | Version 3 by default; repeat D01, T01, T05, and F06 with a version 2 lockfile and verify that both lockfile representations are consistent. |
| Initial installation state | Existing `node_modules` by default. Repeat D01, T01, and T07 with only the initial manifest/lockfile present. |
| Filesystem paths | Include spaces and shell-sensitive characters in fixture directory names. |
| Platforms | Default full suite on Linux; real Windows smoke cases D01, T01, O03, and F06 to cover command shims and path handling. |
| Network | Local fixture services only; fresh caches; unexpected requests fail. |

## Review choices still open

1. D04: updating all compatible declarations when the same direct package appears in multiple sections.
2. O02: failing rather than overwriting a conflicting pre-existing override.
3. R03: excluding candidates whose release age cannot be verified.
4. F03: restoring the manifest and lockfile on a failed application, with explicit reporting about `node_modules`.

These choices are proposals for review, not additional approved remediation strategies. Exact CLI output, exit codes for partial outcomes, invocation flags, and recovery mechanics belong in the subsequent tool design.

## Concrete package.json inputs

This appended section supplements every case above without changing its setup, expectations, or review status. Each JSON block is a complete `package.json` for the labeled root project or fake published package. Alternative blocks are separate fixture variants, not files to combine.

Unless labeled as a temporary application state, a diagnostic control, or a later-run input, root files below are the files present **before application**. They intentionally keep the old lower bound; the initial lockfile records the installed vulnerable version `6.0.9`. A caret or tilde requirement alone does not establish that initial installed version.

Registry-package files describe the `package.json` inside fake tarballs and the corresponding dependency metadata served by the fake registry. These are registry packages, not npm workspaces or `file:` dependencies. The same fake name/version may have different manifests in different isolated cases, but its manifest must remain immutable within a single case.

Publication timestamps, advisory responses, initial lockfile layout, transport failures, integrity failures, and phase checkpoints remain separate harness inputs. Where several variants share the same manifest, that is stated explicitly rather than inventing package.json fields for those external inputs.

#### Shared leaf-package manifests

Use these complete leaf manifests wherever a case below does not supply a case-specific replacement for that package/version. Supporting versions for the same range are published with the same minimal shape and their explicit version. No leaf has hidden dependency edges.

**Registry: e2e-target@6.0.9**

```json
{
  "name": "e2e-target",
  "version": "6.0.9",
  "main": "index.js"
}
```

**Registry: e2e-target@6.0.10**

```json
{
  "name": "e2e-target",
  "version": "6.0.10",
  "main": "index.js"
}
```

**Registry: e2e-target@6.0.12**

```json
{
  "name": "e2e-target",
  "version": "6.0.12",
  "main": "index.js"
}
```

**Registry: e2e-target@6.0.13**

```json
{
  "name": "e2e-target",
  "version": "6.0.13",
  "main": "index.js"
}
```

**Registry: e2e-target@6.0.14-beta.1**

```json
{
  "name": "e2e-target",
  "version": "6.0.14-beta.1",
  "main": "index.js"
}
```

**Registry: e2e-target@6.1.0**

```json
{
  "name": "e2e-target",
  "version": "6.1.0",
  "main": "index.js"
}
```

**Registry: e2e-target@7.0.5**

```json
{
  "name": "e2e-target",
  "version": "7.0.5",
  "main": "index.js"
}
```

**Registry: e2e-unrelated@4.0.0**

```json
{
  "name": "e2e-unrelated",
  "version": "4.0.0",
  "main": "index.js"
}
```

Each tarball includes the declared `index.js`, exporting its package name and version. This lets the harness verify which version a particular parent actually loads. Registry metadata supplies publication times and tarball integrity separately.

### D01 package.json — each operator in each direct dependency section

**Root input — dependencies, ^**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — dependencies, ~**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

**Root input — devDependencies, ^**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "devDependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — devDependencies, ~**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "devDependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

**Root input — peerDependencies, ^**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "peerDependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — peerDependencies, ~**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "peerDependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

**Root input — optionalDependencies, ^**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "optionalDependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — optionalDependencies, ~**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "optionalDependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

Registry inputs: shared leaf manifests. Each variant initially locks `e2e-target@6.0.9`. After success, only the corresponding version lower bound becomes `6.0.12`; the operator and section stay as shown.

### D02 package.json — caret and tilde upper bounds

**Root input — caret variant**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — tilde variant**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

Registry inputs: shared leaves; the publication time of `6.1.0` is old enough in this case. No manifest difference is needed for that release-age change.

### D03 package.json — excluded exact direct pin

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

Registry inputs: shared leaves. This root manifest must remain unchanged.

### D04 package.json — multiple direct declarations

**Root input — compatible declarations**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "devDependencies": {
    "e2e-target": "~6.0.8"
  },
  "peerDependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — exact pin blocks the shared installation**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "devDependencies": {
    "e2e-target": "6.0.9"
  },
  "peerDependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Registry inputs: shared leaves. Both variants initially resolve their declarations to the same `6.0.9` installation. The expectation for updating both compatible declarations remains subject to the review choice recorded above.

### T01 package.json — direct parent and removable temporary override

**Root input — parent declared in dependencies**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Root input — parent declared in devDependencies**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "devDependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Root input — parent declared in peerDependencies**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "peerDependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Root input — parent declared in optionalDependencies**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "optionalDependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4 — caret-child variant**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: e2e-parent-a@1.2.4 — tilde-child variant**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

**Registry: newer parent used to detect accidental parent upgrades**

```json
{
  "name": "e2e-parent-a",
  "version": "1.3.0",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Choose one root section and one child operator per variant. The newer parent is exposed only after the initial lock has been created with parent `1.2.4`. Target leaves use the shared catalog.

**Temporary root state — dependencies/caret-child example, not the initial or final file**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  },
  "overrides": {
    "e2e-parent-a@1.2.4": {
      ".": "$e2e-parent-a",
      "e2e-target": "^6.0.12"
    }
  }
}
```

For the tilde-child variant, the corresponding temporary target value is `~6.0.12`. For other root sections, keep the parent in its original section. After cleanup, the complete root file equals that variant's root input above; the lockfile retains the target upgrade.

### T02 package.json — parent is itself transitive

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-ancestor": "^3.0.0"
  }
}
```

**Registry: e2e-ancestor@3.0.0**

```json
{
  "name": "e2e-ancestor",
  "version": "3.0.0",
  "dependencies": {
    "e2e-parent-a": "1.2.4"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Temporary root state — no reference to an undeclared direct parent**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-ancestor": "^3.0.0"
  },
  "overrides": {
    "e2e-parent-a@1.2.4": {
      "e2e-target": "^6.0.12"
    }
  }
}
```

Target leaves use the shared catalog. Remove the temporary rule after resolution; the final root manifest equals the root input.

### T03 package.json — two versions of the same parent

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-ancestor-left": "^3.0.0",
    "e2e-ancestor-right": "^3.0.0"
  }
}
```

**Registry: e2e-ancestor-left@3.0.0**

```json
{
  "name": "e2e-ancestor-left",
  "version": "3.0.0",
  "dependencies": {
    "e2e-parent-a": "1.2.4"
  }
}
```

**Registry: e2e-ancestor-right@3.0.0**

```json
{
  "name": "e2e-ancestor-right",
  "version": "3.0.0",
  "dependencies": {
    "e2e-parent-a": "1.3.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: e2e-parent-a@1.3.0**

```json
{
  "name": "e2e-parent-a",
  "version": "1.3.0",
  "dependencies": {
    "e2e-target": "^7.0.0"
  }
}
```

The initial lock resolves the 1.2.4 parent's target to `6.0.9` and the 1.3.0 parent's target to `7.0.5`. Target leaves use the shared catalog.

### T04 package.json — repeated parent version under different ancestors

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-ancestor-left": "^3.0.0",
    "e2e-ancestor-right": "^3.0.0",
    "e2e-parent-a": "^1.3.0",
    "e2e-parent-b": "^3.0.0",
    "e2e-target": "^7.0.0"
  }
}
```

**Registry: e2e-ancestor-left@3.0.0**

```json
{
  "name": "e2e-ancestor-left",
  "version": "3.0.0",
  "dependencies": {
    "e2e-parent-a": "1.2.4"
  }
}
```

**Registry: e2e-ancestor-right@3.0.0**

```json
{
  "name": "e2e-ancestor-right",
  "version": "3.0.0",
  "dependencies": {
    "e2e-parent-a": "1.2.4",
    "e2e-parent-b": "2.0.0"
  }
}
```

**Registry: repeated e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: root e2e-parent-a@1.3.0**

```json
{
  "name": "e2e-parent-a",
  "version": "1.3.0",
  "dependencies": {
    "e2e-target": "^7.0.0"
  }
}
```

**Registry: exact-pinning e2e-parent-b@2.0.0**

```json
{
  "name": "e2e-parent-b",
  "version": "2.0.0",
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

**Registry: root e2e-parent-b@3.0.0**

```json
{
  "name": "e2e-parent-b",
  "version": "3.0.0",
  "dependencies": {
    "e2e-target": "^7.0.0"
  }
}
```

The safe root A/B versions occupy their names at the root, requiring the older parents to be nested under their respective ancestors. The safe root target occupies the root target name. The fixture lock must then establish and verify two separate 6.0.9 installations: left is referenced only by A's caret; right is shared by A's caret and B's exact pin. Manifests alone do not guarantee a particular hoisting layout. The harness must verify this intended graph before application and fail fixture setup if it is not present.

### T05 package.json — one shared target and compatible requirements

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0",
    "e2e-parent-b": "^2.0.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: e2e-parent-b@2.0.0**

```json
{
  "name": "e2e-parent-b",
  "version": "2.0.0",
  "dependencies": {
    "e2e-target": "~6.0.8"
  }
}
```

The initial lock has a single target `6.0.9` shared by both parents. Target leaves use the shared catalog.

### T06 package.json — one shared target with an incompatible exact pin

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0",
    "e2e-parent-b": "^2.0.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: e2e-parent-b@2.0.0**

```json
{
  "name": "e2e-parent-b",
  "version": "2.0.0",
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

The initial lock has a single `6.0.9` target shared by both parents. The root and all resolutions remain unchanged. Target leaves use the shared catalog.

### T07 package.json — separate eligible and ineligible copies

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^7.0.0",
    "e2e-parent-a": "^1.2.0",
    "e2e-parent-b": "^2.0.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: e2e-parent-b@2.0.0**

```json
{
  "name": "e2e-parent-b",
  "version": "2.0.0",
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

The initial lock must place target `7.0.5` at the root and a separate target `6.0.9` beneath each parent. Only A's 6.x copy is eligible. Target leaves use the shared catalog.

### T08 package.json — exact transitive pin

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

Target leaves use the shared catalog. No root manifest edits or temporary overrides are expected.

### O01 package.json — merge and remove only operation-created entries

**Root input, including pre-existing overrides**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0",
    "e2e-unrelated": "^4.0.0"
  },
  "overrides": {
    "e2e-unrelated": "$e2e-unrelated",
    "e2e-parent-a@1.2.4": {
      ".": "$e2e-parent-a",
      "e2e-side-leaf": "4.0.2"
    }
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8",
    "e2e-side-leaf": "^4.0.0"
  }
}
```

**Registry: e2e-side-leaf@4.0.0**

```json
{
  "name": "e2e-side-leaf",
  "version": "4.0.0",
  "main": "index.js"
}
```

**Registry: e2e-side-leaf@4.0.2**

```json
{
  "name": "e2e-side-leaf",
  "version": "4.0.2",
  "main": "index.js"
}
```

**Temporary root state — one target rule added**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0",
    "e2e-unrelated": "^4.0.0"
  },
  "overrides": {
    "e2e-unrelated": "$e2e-unrelated",
    "e2e-parent-a@1.2.4": {
      ".": "$e2e-parent-a",
      "e2e-side-leaf": "4.0.2",
      "e2e-target": "^6.0.12"
    }
  }
}
```

After cleanup, the complete root file equals the root input shown above, including the unrelated override, side-leaf override, and original `"."` value. Shared target/unrelated leaf manifests apply.

### O02 package.json — conflicting pre-existing target override

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  },
  "overrides": {
    "e2e-parent-a@1.2.4": {
      ".": "$e2e-parent-a",
      "e2e-target": "6.0.9"
    }
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

The published caret would admit a fix, but the existing root override explicitly pins the old version. The proposed conflict policy leaves this root file unchanged. Target leaves use the shared catalog.

### O03 package.json — valid and conflicting direct-parent scopes

**Root input before diagnostic overrides**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Diagnostic control — version-qualified scope without parent preservation**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  },
  "overrides": {
    "e2e-parent-a@1.2.4": {
      "e2e-target": "^6.0.12"
    }
  }
}
```

**Diagnostic control — approved parent-preserving scope**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  },
  "overrides": {
    "e2e-parent-a@1.2.4": {
      ".": "$e2e-parent-a",
      "e2e-target": "^6.0.12"
    }
  }
}
```

**Diagnostic control — explicit conflicting parent specification**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  },
  "overrides": {
    "e2e-parent-a@1.2.4": {
      ".": "^1.2.4",
      "e2e-target": "^6.0.12"
    }
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Run each diagnostic control in a separate copy. In the last control, `^1.2.4` is a different specification from the root's `^1.2.0`, despite overlapping it. Target leaves use the shared catalog.

### O04 package.json — cleanup result is unexpectedly incorrect

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Target leaves use the shared catalog. Use T01's approved temporary root state during application. The incorrect cleanup result is supplied by explicit fault injection at the cleanup phase; it is not encoded as an incompatible published requirement, which would instead be an ordinary ineligible case. This case's fault mechanism remains a harness-design detail; these manifests alone do not trigger the failure.

### R01 package.json — select newest eligible rather than minimum safe

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Registry inputs: shared target leaves. Their publication times and advisory snapshot A cause `6.0.12` to be selected even though `6.0.10` is also safe.

### R02 package.json — all safe in-range versions are too young

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

All variants use this same file and the shared target leaf manifests. Only registry timestamps change: every safe in-range stable version, including `6.0.10`, `6.0.12`, `6.0.13`, and `6.1.0`, is too young.

### R03 package.json — unverifiable release age

**Root input — shared by missing-time, invalid-time, and no-verifiable-fallback variants**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Registry inputs: shared target leaves. For fallback variants, make `6.0.12`'s timestamp missing or invalid and leave `6.0.10` verifiably old; select `6.0.10`. For the no-fallback variant, neither safe old candidate has a valid timestamp; later candidates stay too young or out of range. Timestamps are registry fields, not package.json properties.

### R04 package.json — independent advisory/release-time snapshots

**Root input — identical for variants A, B, and C**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

All three variants use the same shared target leaf manifests. Snapshot and timestamp changes are the ones listed in R04 above: A selects `6.0.12`, B has no eligible fix, C selects `6.0.13`. Do not put advisory ranges or release timestamps into this root file.

### R05 package.json — advisory changes after selection

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root state after selecting and applying 6.0.12, before fresh verification**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.12"
  }
}
```

Registry inputs: shared target leaves. Snapshot B activates only at the explicit phase boundary; `6.0.13` becomes an old-enough alternative as described above. The post-selection file is not evidence of success: verification must report the stale recommendation. Final recovered file contents depend on the still-proposed F03 recovery contract.

### R06 package.json — scoped package names

**Root input**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@e2e/parent": "^1.2.0"
  }
}
```

**Registry: @e2e/parent@1.2.4**

```json
{
  "name": "@e2e/parent",
  "version": "1.2.4",
  "dependencies": {
    "@e2e/target": "^6.0.8"
  }
}
```

**Registry: @e2e/target@6.0.9**

```json
{
  "name": "@e2e/target",
  "version": "6.0.9",
  "main": "index.js"
}
```

**Registry: @e2e/target@6.0.10**

```json
{
  "name": "@e2e/target",
  "version": "6.0.10",
  "main": "index.js"
}
```

**Registry: @e2e/target@6.0.12**

```json
{
  "name": "@e2e/target",
  "version": "6.0.12",
  "main": "index.js"
}
```

**Registry: @e2e/target@6.0.13**

```json
{
  "name": "@e2e/target",
  "version": "6.0.13",
  "main": "index.js"
}
```

**Registry: @e2e/target@6.0.14-beta.1**

```json
{
  "name": "@e2e/target",
  "version": "6.0.14-beta.1",
  "main": "index.js"
}
```

**Registry: @e2e/target@6.1.0**

```json
{
  "name": "@e2e/target",
  "version": "6.1.0",
  "main": "index.js"
}
```

**Registry: @e2e/target@7.0.5**

```json
{
  "name": "@e2e/target",
  "version": "7.0.5",
  "main": "index.js"
}
```

**Temporary root state — scoped reference and selector**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@e2e/parent": "^1.2.0"
  },
  "overrides": {
    "@e2e/parent@1.2.4": {
      ".": "$@e2e/parent",
      "@e2e/target": "^6.0.12"
    }
  }
}
```

After cleanup, the complete root file equals the root input. Apply the target version timing/advisory rules to the scoped target identity.

### F01 package.json — metadata or advisory service fails

**Root input — identical for all three failure variants**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Registry inputs: shared target leaves. Metadata-request failure, advisory-request failure, and malformed advisory JSON are controlled service responses, not alternative manifests. Keep the seeded initial installation intact before injecting the failure.

### F02 package.json — installation fails

**Root input — unavailable-tarball and integrity-mismatch variants**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Root input — peer-resolution-conflict variant**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8",
    "e2e-host": "^1.0.0"
  }
}
```

**Registry: old e2e-target@6.0.9 — peer-conflict variant only**

```json
{
  "name": "e2e-target",
  "version": "6.0.9",
  "main": "index.js",
  "peerDependencies": {
    "e2e-host": "^1.0.0"
  }
}
```

**Registry: selected e2e-target@6.0.12 — peer-conflict variant only**

```json
{
  "name": "e2e-target",
  "version": "6.0.12",
  "main": "index.js",
  "peerDependencies": {
    "e2e-host": "^2.0.0"
  }
}
```

**Registry: e2e-host@1.0.0**

```json
{
  "name": "e2e-host",
  "version": "1.0.0",
  "main": "index.js"
}
```

**Registry: e2e-host@2.0.0**

```json
{
  "name": "e2e-host",
  "version": "2.0.0",
  "main": "index.js"
}
```

Other target versions use the shared leaves. In the peer variant, the initial target and host are compatible; application of the selected `6.0.12` introduces the conflict with the unchanged direct host. Use ordinary peer resolution with `force` and `legacy-peer-deps` disabled. The missing-tarball and integrity variants instead change tarball service/metadata responses after setup. No variant authorizes a host or parent upgrade.

### F03 package.json — preserve uncommitted user changes on failure

**Tracked root baseline — before the user edits it**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0",
    "e2e-unrelated": "^4.0.0"
  },
  "description": "Original tracked description"
}
```

**Actual root input immediately before application — must survive failed application**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0",
    "e2e-unrelated": "^4.0.0"
  },
  "description": "User edit: keep this description during recovery",
  "devDependencies": {
    "e2e-user-helper": "^2.0.0"
  },
  "config": {
    "userNote": "Keep this unrelated setting"
  }
}
```

**Registry: e2e-parent-a@1.2.4**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: e2e-user-helper@2.0.1**

```json
{
  "name": "e2e-user-helper",
  "version": "2.0.1",
  "main": "index.js"
}
```

Shared target/unrelated leaves apply. The initial-install-failure and cleanup-install-failure variants share the same input. Capture the already user-edited lockfile as well. Under the proposed recovery policy, restore the actual pre-application file, not the tracked baseline.

### F04 package.json — clean project or unsupported targets

**Root input — clean audit, initially locked at safe 6.0.12**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.12"
  }
}
```

**Root input — vulnerable exact direct pin**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

**Root input — vulnerable exact transitive pin**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4 — exact-transitive variant only**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "6.0.9"
  }
}
```

Target leaves use the shared catalog. The clean variant uses advisory snapshot A and a safe initial lock; the other two variants retain their vulnerable pinned installations. All root manifests remain unchanged.

### F05 package.json — second run is a no-op

**Direct variant — root input to first run**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Direct variant — root input to second run after successful remediation**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.12"
  }
}
```

**Transitive variant — root file before first run and after cleanup, also input to second run**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  }
}
```

**Registry: e2e-parent-a@1.2.4 — transitive variant**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

Target leaves use the shared catalog. Both second runs start with the successfully upgraded lockfile and installed target `6.0.12`; the transitive root file is unchanged even though its lockfile changed on the first run. Registry/advisory data stays fixed between runs.

### F06 package.json — real tarballs, script suppression, clean reproduction

**Root input with lifecycle-script sentinels**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-parent-a": "^1.2.0"
  },
  "scripts": {
    "preinstall": "node -e \"require('node:fs').writeFileSync('e2e-root-preinstall-ran', 'unexpected')\"",
    "postinstall": "node -e \"require('node:fs').writeFileSync('e2e-root-postinstall-ran', 'unexpected')\""
  }
}
```

**Registry: e2e-parent-a@1.2.4 with lifecycle scripts**

```json
{
  "name": "e2e-parent-a",
  "version": "1.2.4",
  "dependencies": {
    "e2e-target": "^6.0.8"
  },
  "scripts": {
    "preinstall": "node -e \"require('node:fs').writeFileSync('e2e-parent-preinstall-ran', 'unexpected')\"",
    "postinstall": "node -e \"require('node:fs').writeFileSync('e2e-parent-postinstall-ran', 'unexpected')\""
  }
}
```

**Registry: e2e-target@6.0.9 with lifecycle scripts**

```json
{
  "name": "e2e-target",
  "version": "6.0.9",
  "main": "index.js",
  "scripts": {
    "preinstall": "node -e \"require('node:fs').writeFileSync('e2e-target-6.0.9-preinstall-ran', 'unexpected')\"",
    "postinstall": "node -e \"require('node:fs').writeFileSync('e2e-target-6.0.9-postinstall-ran', 'unexpected')\""
  }
}
```

**Registry: e2e-target@6.0.12 with lifecycle scripts**

```json
{
  "name": "e2e-target",
  "version": "6.0.12",
  "main": "index.js",
  "scripts": {
    "preinstall": "node -e \"require('node:fs').writeFileSync('e2e-target-6.0.12-preinstall-ran', 'unexpected')\"",
    "postinstall": "node -e \"require('node:fs').writeFileSync('e2e-target-6.0.12-postinstall-ran', 'unexpected')\""
  }
}
```

Other target versions use shared leaves. The tarballs include `index.js`; the sentinel commands need no additional script files. Both fixture setup and application disable lifecycle scripts, as does the clean reproduction command. Search both installed dependency trees and the root directories for sentinel files.

## Final design addendum — IDs, single-target execution, Git, and supporting dependencies

Date: 2026-10-20

This committed catalog preserves the reviewed temporary draft in full above. This addendum reconciles the later agreed CLI and Git behavior; where expectations differ, this addendum and the companion design take precedence. Existing case IDs remain valid.

### Clarifications to the original cases

- Application is performed by the actual `npm-dep-upgrade` CLI. One invocation selects exactly one fresh planner item by hash, optionally filtered by exact package name. There is no saved-plan file, item-number selector, or `--to` flag.
- D04's compatible declarations are all updated with their original operators. O02's conflicting pre-existing policy is not overwritten. R03 excludes candidates with unverifiable release age. These review choices were accepted with the test catalog.
- Existing cases that discuss multiple eligible targets must choose one ID per invocation and assert the single-target boundaries. Scoping the ID does not authorize automatically applying the other rows.
- The selected package may bring necessary supporting dependency changes. All other installations of the selected package remain unchanged. The selected location and its incoming consumers must remain valid after cleanup.
- F03's pre-existing dirty manifest/lockfile setup now expects an early refusal, not an attempted upgrade. Preserve all user bytes and the staging area. The recovery variants below begin with clean tracked dependency files and allow unrelated unstaged edits.
- F04 must attempt a specific valid-shaped selector and expect target-not-found for a clean report or an ineligible error for a matching unsupported row. It makes no mutation or commit.
- F05 repeats the same ID after successful remediation. When the finding is gone, the second invocation exits with target-not-found, makes no changes, and creates no second commit. No generic no-findings success is required.
- F01's unavailable/malformed security service variants also exercise candidate-version advisory lookup. A candidate's advisory can exist without affecting the installed old version; the tool must still exclude that candidate before installation.
- Application and cleanup use `npm install --ignore-scripts --min-release-age=7`. Uncached final advisory verification is mandatory.

### H01 — Full deterministic planner IDs and Markdown abbreviations

**Setup:** Real planner output includes eligible and ineligible installations, repeated names at distinct locations, and a scoped package. Reuse T07 and R06 manifests in separate fixture projects.

**Expect:** Every row has the correct full lowercase SHA-256 ID derived from `package + "__" + targetLocation`. Markdown displays its first seven characters. IDs differ across locations and remain identical after row reordering, project-directory relocation, or a changed installed version at the same package/location. Include the version-change invariant as a pure ID test when the upgraded version no longer produces a planner row. Existing schema version 2 fields and ordering retain their meaning.

### H02 — Human and automation selection

**Setup:** T01's root and registry manifests; the requested item has a unique prefix.

**Variants:** Seven-character ID; longer prefix; full ID; full ID plus exact `--package`; scoped-name equivalent from R06.

**Expect:** Invoke the real planner during each run, select only the intended current row, and complete one verified upgrade and one commit. There is no planner JSON input file. Record the actual selected old version from the fresh report rather than inferring it from the hash.

### H03 — Actual prefix collision between different packages

**Setup:** Use two precomputed valid fake package names with root installation locations whose real SHA-256 IDs share the first seven characters. Both are vulnerable, caret-declared direct dependencies. Verify the collision from the production hash formula at fixture setup; do not replace the hash implementation in the main E2E test.

**Root input shape:** A complete generated manifest has `name: e2e-app`, `version: 1.0.0`, `private: true`, and `dependencies` mapping each of those two concrete collision names to `^6.0.8`. Their published leaf manifests use the shared target versions with the respective actual names. The fixture generator freezes the two names as test data; the choice of names has no product behavior significance.

**Expect:** The seven-character selector alone is ambiguous and causes no mutation/commit. Adding the exact package name disambiguates it; a sufficiently long ID also disambiguates it. Upgrade only that package's selected installation.

### H04 — Actual prefix collision between locations of the same package

**Setup:** Use one fake target name and two concrete parent locations with precomputed colliding seven-character ID prefixes. Each parent permits the 6.x upgrade; a safe root 7.x target keeps the two 6.x copies separate, as in T07. Use real computed hashes, not injected IDs.

**Expect:** Prefix plus package name remains ambiguous. A longer unique prefix or full ID selects one location. The other 6.x installation stays at its original version until a separate invocation is made for its own ID.

### H05 — Invalid input and invalid planner-contract controls

**CLI variants:** Missing selector, fewer than seven characters, more than 64 characters, nonhexadecimal input, multiple selectors, unknown options, wrong package filter, unknown ID, and a matching ineligible ID.

**Expect:** Errors without mutation or commit; ambiguity/not-found/ineligible diagnostics are distinguishable.

**Adapter/unit controls:** Missing IDs, mismatched recomputed IDs, duplicate full IDs, unsupported strategy, failed planner, and malformed JSON. Reject rather than choosing one row. Exercise hypothetical full-hash collision handling with controlled adapter inputs; do not claim to have generated a genuine full SHA-256 collision. These controls supplement the real-planner E2E suite.

### G01 — Clean dependency files and empty repository staging area

**Setup:** Use D01 or T01 with committed initial manifests and locks.

**Variants:** Unstaged manifest edit; unstaged lockfile edit; staged manifest edit; staged lockfile edit; staged unrelated file anywhere in the repository; untracked dependency file; missing dependency file.

**Expect:** Refuse before mutation. Preserve all file bytes and staging contents. No install, blanket Git restore, stash, or new commit. These replace the dirty-dependency-file application portion of F03.

### G02 — Unrelated unstaged work is preserved

**Setup:** Clean tracked D01/T01 dependency files, empty staging area, and an unrelated unstaged tracked-file edit plus an unrelated untracked file. Include a project located below the Git repository root.

**Expect:** Upgrade and commit successfully. The commit contains only that project's changed dependency files. Unrelated files remain as they were, unstaged and uncommitted. Path handling works for nested projects and paths with spaces/shell-sensitive characters.

### G03 — Exactly one verified commit with the required subject

**Setup:** Record initial HEAD for D01 and T01.

**Expect:** One new commit. Subject is exactly `deps: bump <resolved-package-name> from <observed-old-version> to <verified-new-version>`. A direct upgrade normally changes both dependency files; a transitive-only upgrade normally changes only the lockfile. No temporary override remains in the committed manifest. Commit paths, committed file contents, current dependency files, and reported commit hash agree. No push or tag occurs.

### G04 — Recovery before commit preserves the initial files

**Setup:** Clean tracked dependency files, empty staging, unrelated unstaged work. Reuse F02's install failures and O04's cleanup-verification failure; inject failures at both install phases in separate runs.

**Expect:** No new commit. Restore the captured dependency-file bytes and preserve unrelated work, provided no concurrent edits intervened. Do not claim that `node_modules` was restored unless it was rebuilt and verified. A failed restore reports both the original failure and recovery failure.

### G05 — Stale recommendation creates no commit

**Setup:** R05's explicit advisory-phase switch, with a committed initial project.

**Expect:** Report stale recommendation, perform the defined dependency-file recovery, preserve unrelated work, and create no commit. The next invocation may plan afresh; the failed invocation never silently switches to a different target version.

### G06 — Git preconditions and commit failure

**Preflight variants:** Missing author/committer identity, detached HEAD, or an in-progress Git operation. Refuse before application and preserve state.

**Commit-failure variant:** A deterministic rejecting Git hook after the dependency update has been verified. Preserve the verified dependency-file changes for inspection/retry; remove only operation-owned staging where safe; report failure and the resulting Git state. Never report a successful commit merely because npm verification passed. This is distinct from pre-staging recovery in G04.

### G07 — No silent concurrent-state overwrite

**Setup:** Introduce a controlled user edit, staged file, or HEAD movement at an explicit pre-write/pre-commit checkpoint.

**Expect:** Detect changed state, fail, and do not overwrite or commit the concurrent work. Do not reset the repository to the original HEAD. Use deterministic checkpoints rather than timing sleeps.

### S01 — Required supporting dependency upgrade is allowed

**Root input:**

```json
{
  "name": "e2e-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "e2e-target": "^6.0.8"
  }
}
```

**Registry: old target manifest:**

```json
{
  "name": "e2e-target",
  "version": "6.0.9",
  "main": "index.js",
  "dependencies": {
    "e2e-helper": "^2.0.0"
  }
}
```

**Registry: selected target manifest:**

```json
{
  "name": "e2e-target",
  "version": "6.0.12",
  "main": "index.js",
  "dependencies": {
    "e2e-helper": "^3.0.0"
  }
}
```

Publish minimal helper leaf manifests for `e2e-helper@2.0.5` and `e2e-helper@3.0.2`, both safe and old enough. In this case's target catalog, `6.0.12` is the newest eligible target. Initial setup locks the target at `6.0.9` and helper at `2.0.5`.

**Expect:** Target becomes `6.0.12`, helper becomes `3.0.2`, root requirement becomes `^6.0.12`, fresh verification and clean reproduction pass, and one commit records the selected target upgrade with the supporting lockfile changes.

### S02 — Supporting changes do not authorize unrelated target upgrades

**Setup:** Combine S01's selected branch with a second installation of the same target package at another location. Add an unrelated direct package with a newer published version to detect unrelated resolver churn.

**Expect:** Allow the selected branch's necessary helper changes. Preserve the other target installation's location/version and the unrelated direct requirement/resolution. Reject the attempt if the override/install scope changes the other target copy. Include supporting additions/removals and consumers sharing supporting packages in graph-verifier tests.

### S03 — Supporting package introduces a vulnerability

**Setup:** S01, but the fresh advisory snapshot identifies the selected release's helper version as vulnerable.

**Expect:** Do not commit a newly introduced vulnerable supporting package/version. Report verification failure and recover the dependency files. Do not upgrade an unrelated package or silently select another target release as a new strategy.

### Matrix extension

Run the real hash-selection, Git preflight/commit, and supporting-upgrade success paths on default npm 12.1.0. Repeat H02, G03, and S01 on npm 11.10.0. Keep pure full-collision, ID-canonicalization, range-boundary, and exact-time-boundary cases in focused unit/adapter suites; retain real resolver/installer/registry/Git boundaries in the main E2E cases.

### Project-directory follow-up

The CLI accepts `npm-dep-upgrade [project] <id-or-prefix>`. One positional argument is the ID in the caller's directory; two are project then ID. Relative paths resolve against the caller. H05's multiple-ID control supplies a project plus two IDs, exceeding the two allowed positionals. Add absolute/relative path cases from another repository with dirty dependency files and staged unrelated work; those caller files, index and HEAD remain untouched while the selected nested target project is upgraded and committed.
