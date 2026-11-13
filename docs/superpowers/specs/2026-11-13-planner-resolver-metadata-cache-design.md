# Planner resolver: TTL-bound registry metadata cache

Date: 2026-11-13

## Intent

With warm audit, paths and versions caches (and a cold planner result cache),
`npm-dep-upgrade-plan` still took 173 s on `uum-dep-test/webapp`. 153 s (89%)
was 56 resolver-worker runs (`src/resolver-worker.js`). Each run is a fresh
Node process that downloads every package's registry metadata (packument)
again: the worker sets `preferOnline: true`, and every `new Arborist(opts)`
starts with an empty in-memory `PackumentCache`, so one worker refetches the
same packument for each load, probe and build. 41 runs came from the
`minimatch@10.2.5` parent search, 13 from `fast-xml-parser@5.7.1`, and 2 from
`glob@10.5.0`.

Agreed with the user: the resolver should use a cache that follows the
planner's TTL (`--cache-ttl`, default 1 hour). Repeat requests for the same
package's metadata within that period are served from the cache, both
within one planner run and across runs.

## Goals

- A packument fetched by any resolver worker is reused by later lookups
  (the same worker, later workers, later planner runs) until it is older
  than the TTL.
- `--no-cache`, `--clear-cache` and `--cache-ttl` keep their documented
  meaning and also govern this cache.
- The plan's freshness reflects the oldest registry metadata it relied on.

## Non-goals

- Caching whole resolver results (choice sets and their verdicts).
- One long-lived worker per run. This would save the per-check process
  startup and could be a later step, measured after this change.
- Changing `npm-dep-upgrade` or any sibling tool, or sharing data with the
  `npm-dep-versions` catalog cache. Catalogs hold only versions and release
  times, not the per-version dependencies Arborist needs.

## Anti-goals

- Serving metadata older than the TTL, or extending an entry's age on reuse.
- Storing credentials, auth headers or npm configuration values.
- Changing `~/.npm` behavior or relying on npm's HTTP cache freshness.
- Any change to report contents other than freshness and expiry.

## Approaches considered

1. **Planner-owned disk cache plugged into Arborist's `packumentCache`
   option (chosen).** Arborist 10 (npm 12) and pacote accept a
   caller-supplied `packumentCache` (Map-like `has/get/set/delete`, keyed
   `full:<url>` or `corgi:<url>`). The planner controls the TTL, keys and
   clearing, and reuse covers all three scopes.
2. **Use npm's own `~/.npm/_cacache` via `preferOffline`.** Close to a
   one-line change, but npm would serve metadata of any age (no TTL), and that
   cache is shared with everyday npm use. Rejected: it can't honor the TTL.
3. **One long-lived worker with an in-memory cache.** Saves process startup,
   but the cache is lost when the run ends, so it doesn't meet the
   across-runs goal. Deferred (see Non-goals).

## Design

- **Store.** Entries live under the planner's existing cache directory, in
  `$XDG_CACHE_HOME/npm-dep-upgrade-plan/packuments/` (default
  `~/.cache/npm-dep-upgrade-plan/packuments/`): one file per key, directory
  mode 0700 and files 0600, written atomically (temp file + rename) and
  treated as nonfatal, like the existing result cache. A malformed,
  unreadable or expired entry is a miss.
- **Key.** A SHA-256 digest of: a cache schema number, the planner version,
  the npm version, the npm configuration digest the planner already computes
  (`readNpmConfiguration`; covers registries, scoped registries and auth
  sources without storing their values), and pacote's own cache key
  (`full:`/`corgi:` + packument URL). Full and corgi documents stay separate
  because pacote fetches full metadata whenever `before` is set (the parent
  strategy's release-time cap). npm stores packuments unfiltered and applies
  `before` when it picks a manifest, so the cached document doesn't depend on
  the cutoff.
- **Entry.** `{ key, fetchedAt, packument }` plus a checksum. The entry is
  valid while `0 <= now - fetchedAt < ttlMs`. `fetchedAt` is never refreshed
  on reuse.
- **Worker wiring.** The planner adds the TTL, the no-cache flag, the cache
  directory and the identity digest to the resolver request. The worker
  builds one Map-like cache per process and passes it as `packumentCache`
  to every `new Arborist(...)` it creates (load, probes, builds,
  `landAncestor`, `buildLineTree`). `has(key)` checks memory, then reads the
  disk entry synchronously and loads it into memory if it's valid. `set`
  stores in memory and writes to disk. `preferOnline: true` stays, so a miss
  still fetches current data from the registry.
- **Freshness.** The worker's `freshAt` becomes the minimum of
  `request.startedAt` and the `fetchedAt` of every disk entry it served. The
  planner already takes the minimum over all resolver results, so a cached
  plan expires no later than its oldest metadata plus the TTL.
- **Controls.** With `--no-cache`, the worker neither reads nor writes disk
  entries but still shares one in-memory cache across its own Arborist
  instances (same-moment data, like a single npm command). `--clear-cache`
  needs no new code: it already deletes the whole planner cache directory,
  including `packuments/`. `--debug` logs hit/miss/bypass for metadata
  lookups, consistent with other cache decisions.
- **Docs and version.** Update the planner README's cache section and the
  `AGENTS.md` planner line about caches. Bump the planner minor version
  (0.11.1 → 0.12.0), together with its lockfile, in the final commit.

## Calls made by Claude (open to correction)

- Shared in-memory reuse stays on under `--no-cache` (bypass applies to disk
  only).
- Entries are stored gzip-compressed, because full packuments for large
  packages can be several MB. Expired entries are deleted when encountered;
  no separate pruning pass.
- Minor version bump: this adds a capability and changes freshness
  behavior.

## Left to the builder

- Exact module layout (for example a `src/packument-cache.js` loaded by the
  worker) and how the identity digest reaches the worker when `--no-cache`
  skips `readPlanningContext`.
- Test strategy: unit tests for the store (hit, expiry, key isolation by
  npm version and configuration, corrupt entry, nonfatal write failure,
  no-cache) plus a worker-level test showing that a second resolve makes no
  registry request for a cached packument.
- Verification: repeat the timing run from this investigation (copied
  sibling caches in a scratch `XDG_CACHE_HOME`, cold planner result cache,
  `--debug`) before and after the change. Report total time, resolver-worker
  time, and the packument cache directory's size.
