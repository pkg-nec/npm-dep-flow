# Contributing

## Commit messages and pull request titles

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for every commit message and pull request title.

Use this header format:

```text
<type>[optional scope][!]: <description>
```

Choose a type that describes the change. Common types include `feat` for a new feature, `fix` for a bug fix, `docs` for documentation, `test` for tests, `refactor` for a behavior-preserving code change, `ci` for CI changes, `build` for build or dependency changes, and `chore` for other maintenance. A scope is optional; use it to identify the affected tool or area, such as `audit`, `paths`, `upgrade-plan`, or `ci`.

Examples:

```text
feat(audit): add JSON report output
fix(paths): handle a missing lockfile
docs: explain local setup
```

For a breaking change, put `!` after the type or scope. Commit messages may also describe the change in a `BREAKING CHANGE:` footer:

```text
feat(audit)!: change the report schema

BREAKING CHANGE: consumers must read the new report field.
```

Make each commit message describe that commit. Make the pull request title describe the overall change in the pull request, using the same header format. For example:

```text
feat(audit): add JSON report output
```
