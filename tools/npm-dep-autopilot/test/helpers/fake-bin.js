import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const header = '#!/usr/bin/env node\nconst fs = require("node:fs")\nconst path = require("node:path")\nconst { execFileSync } = require("node:child_process")\nconst state = process.env.FAKE_STATE_DIR\nconst args = process.argv.slice(2)\n'

const scripts = {
  'gh': `${header}
fs.appendFileSync(path.join(state, 'gh-calls.log'), JSON.stringify(args) + '\\n')
if (args[0] === 'auth') process.exit(fs.existsSync(path.join(state, 'gh-logged-out')) ? 1 : 0)
if (args[0] === 'api') console.log('maw')
if (args[0] === 'pr' && args[1] === 'list') console.log('[]')
if (args[0] === 'pr' && args[1] === 'create') console.log('https://example.test/pull/1')
`,
  'npm-dep-upgrade-plan': `${header}
const upgraded = fs.existsSync(path.join(state, 'upgraded'))
const rows = upgraded ? [] : [{ id: 'f'.repeat(64), package: 'brace-expansion', version: '5.0.9', targetLocation: 'node_modules/brace-expansion', severity: 'critical', resolution: 'complete', choices: [{ strategy: 'update-within-declared-range', targetPackage: 'brace-expansion', currentVersion: '5.0.9', targetVersion: '5.0.12' }] }]
console.log(JSON.stringify({ schemaVersion: 3, auditedAt: new Date().toISOString(), rows }))
`,
  'npm-dep-upgrade': `${header}
const project = args[0]
fs.writeFileSync(path.join(project, 'fixed.txt'), 'fixed')
execFileSync('git', ['add', 'fixed.txt'], { cwd: project })
execFileSync('git', ['commit', '-q', '-m', 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12'], { cwd: project })
fs.writeFileSync(path.join(state, 'upgraded'), '1')
console.log(JSON.stringify({ schemaVersion: 3, id: args[1], package: 'brace-expansion', oldVersion: '5.0.9', targetLocation: 'node_modules/brace-expansion', resolution: 'complete', actions: [{ strategy: 'update-within-declared-range', targetPackage: 'brace-expansion', currentVersion: '5.0.9', targetVersion: '5.0.12', outcome: 'applied' }], commits: [{ hash: 'abc1234', subject: 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12', actionIndex: 0, changedFiles: ['fixed.txt'] }] }))
`,
}

export function installFakes() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'autopilot-fakes-'))
  const bin = path.join(root, 'bin')
  const stateDir = path.join(root, 'state')
  const runtimeDir = path.join(root, 'run')
  for (const dir of [bin, stateDir, runtimeDir]) mkdirSync(dir)

  for (const [name, source] of Object.entries(scripts)) {
    const file = path.join(bin, name)
    writeFileSync(file, source)
    chmodSync(file, 0o755)
  }

  return { bin, stateDir, runtimeDir }
}
