# Repository guide for agents

## Repository layout

- This repository contains small command-line tools for maintaining Node.js project dependencies. The root contains shared documentation; it is not an npm package or workspace.
- Each `tools/<name>/` directory is an independent Node.js project with its own manifest, lockfile, executable, source, tests, and README. Keep tool dependencies and npm commands within the relevant tool directory.
- Tools should exchange data through documented command-line output, including versioned JSON, rather than importing another tool's private source files.
- Start with the [repository README](README.md) for the tool index. The current tool is [npm-dep-audit](tools/npm-dep-audit/README.md); its detailed design is in [the audit spec](docs/superpowers/specs/2026-10-09-npm-dep-audit-design.md).

## Working on npm-dep-audit

- Use Node.js 20 or newer. From `tools/npm-dep-audit/`, run `npm ci --ignore-scripts` to install the tool's dependencies and `npm test` to run its `node:test` suite. There is no root-level `npm test`.
- The executable is `bin/npm-dep-audit.js`. `src/cli.js` coordinates project loading, npm context, caching, row construction, and rendering; focused tests live in `test/`.
- The tool reads a target project's `package.json` and `package-lock.json` and runs `npm audit --json` from that project's directory. It must not install dependencies, run lifecycle scripts, or modify files in the target project. Its cache lives outside the target project.
- Preserve the documented CLI and output contracts in the [tool README](tools/npm-dep-audit/README.md): Markdown and versioned JSON reports, exit 0 for a completed report even when vulnerabilities are found, and exit 1 for errors without a partial report on stdout.
- Keep npm subprocess launching portable: Windows uses `npm.cmd` through a shell; Unix-like systems spawn `npm` directly. Test both paths when changing subprocess behavior.
