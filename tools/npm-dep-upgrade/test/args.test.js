import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { parseArgs } from '../src/args.js'

test('CLI selects exactly one hash and accepts package/format in either order', () => {
  assert.deepEqual(parseArgs(['abcdef0']), { projectPath: process.cwd(), selector: 'abcdef0', packageName: null, format: 'markdown', action: 'upgrade', provided: [] })
  assert.equal(parseArgs(['--package', '@e2e/target', 'a'.repeat(64), '--format', 'json']).packageName, '@e2e/target')
  assert.equal(parseArgs(['--help']).action, 'help')
  assert.equal(parseArgs(['--version']).action, 'version')
})
test('CLI rejects ambiguous, malformed, and excluded input forms', () => {
  for (const argv of [[], ['aaaaaa'], ['a'.repeat(65)], ['ABCDEF0'], ['zzzzzzz'], ['.', 'abcdef0', '1234567'], ['abcdef0', '--to', '1.0.0'], ['--item', '3'], ['--plan', 'plan.json'], ['abcdef0', '--package'], ['abcdef0', '--format', 'text']]) {
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv))
  }
})

test('CLI resolves an optional project before the item ID against the caller directory', () => {
  const cwd = path.resolve('/workspace/caller')
  for (const [project, expected] of [['.', cwd], ['../target space & dollar $', path.resolve(cwd, '../target space & dollar $')], [path.resolve('/another/project'), path.resolve('/another/project')], ['abcdef0', path.resolve(cwd, 'abcdef0')]]) {
    const result = parseArgs(['--format', 'json', project, 'abcdef0', '--package', '@e2e/target'], cwd)
    assert.equal(result.projectPath, expected)
    assert.equal(result.selector, 'abcdef0')
    assert.equal(result.packageName, '@e2e/target')
    assert.equal(result.format, 'json')
  }
  assert.equal(parseArgs(['abcdef0'], cwd).projectPath, cwd)
})
test('CLI validates the ID after an explicit project and short-circuits help/version', () => {
  for (const args of [['../target'], ['../target', 'bad-id'], ['../target', 'ABCDEF0'], ['../target', 'abcdef0', '1234567']]) assert.throws(() => parseArgs(args), undefined, JSON.stringify(args))
  assert.equal(parseArgs(['missing-project', '--unknown', '--help']).action, 'help')
  assert.equal(parseArgs(['missing-project', '--version']).action, 'version')
})

test('commit argument clearing cannot be mixed with supplied commit arguments in either order', () => {
  for (const flags of [['--git-commit-arg=--signoff', '--clear-git-commit-args'], ['--clear-git-commit-args', '--git-commit-arg=--signoff']]) assert.throws(() => parseArgs(['abcdef0', ...flags]), /combine/)
})

test('new options reject missing values and conflicting repeated settings', () => {
  for (const flags of [['--config'], ['--module'], ['--commit-message-template'], ['--git-commit-arg='], ['--config', 'a.json', '--config', 'b.json'], ['--module', 'api', '--module', 'webapp'], ['--debug', '--no-debug'], ['--clear-git-commit-args', '--clear-git-commit-args']]) assert.throws(() => parseArgs(['abcdef0', ...flags]))
})
test('--clear-cache is a switch recorded only when supplied and rejected when repeated', () => {
  assert.equal(parseArgs(['abcdef0']).clearCache, undefined)
  const options = parseArgs(['abcdef0', '--clear-cache'])
  assert.equal(options.clearCache, true)
  assert.ok(options.provided.includes('clearCache'))
  assert.throws(() => parseArgs(['abcdef0', '--clear-cache', '--clear-cache']), /Repeated/)
})
