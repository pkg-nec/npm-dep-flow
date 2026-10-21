# npm-dep-versions

Inspect package versions and publication dates using your npm registry configuration.
Requires Node.js 20+ and npm on PATH. Install independently with `npm install --global . --ignore-scripts` from this tool directory.

```sh
npm-dep-versions react
npm-dep-versions react --all
npm-dep-versions react --major 19
npm-dep-versions react --range '>=18 <20'
npm-dep-versions @scope/pkg --project /path/to/app --format json
```

Stable releases are the default; `--all` includes prereleases. `--major` and `--range` intersect when combined. Quote range expressions in your shell. With `--all`, range matching includes prereleases within the actual semantic version bounds. Stable does not mean vulnerability-free or nondeprecated.

The tool fetches `versions` and `time` in one `npm view` command, retains versions with unknown dates, ignores time-only entries, and sorts by semantic version ascending. `--project` selects the directory whose npm configuration applies; it defaults to the current directory and requires no manifest or lockfile. The selected directory is never modified.

Markdown is the default. `--format json` returns schema version 2 with `package`, original `fetchedAt`, and `rows` containing `version` and nullable UTC `releasedAt`. Empty results exit 0. Errors exit 1 with a stderr diagnostic and no partial stdout. Use `--help` for all options; `--debug` logs external actions to stderr.
