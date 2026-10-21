import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { main } from '../src/cli.js'
async function fixture(t, value) {
  const root = await mkdtemp(path.join(tmpdir(), 'upgrade-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'config.json')
  await writeFile(file, JSON.stringify(value))
  return { root, file }
}
test('configured project reaches preflight and positional project overrides it', async (t) => {
  const f = await fixture(t, { project: './nested app', module: 'webapp' }), seen = [], cwd = process.cwd()
  const io = { stdout: { write() {} }, stderr: { write() {} } }
  const stop = { preflightGit: async (root) => {
    seen.push(root)
    throw new Error('stop')
  } }
  await main(['abcdef0', '--config', f.file], io, stop)
  await main(['./api', 'abcdef0', '--config', f.file], io, stop)
  assert.deepEqual(seen, [path.join(f.root, 'nested app'), path.resolve(cwd, 'api')])
  assert.equal(process.cwd(), cwd)
})
test('config merging preserves explicit false and replaces arrays without leaking between calls', async (t) => {
  const { resolveOptions } = await import('../src/config.js'), { parseArgs } = await import('../src/args.js')
  const f = await fixture(t, { package: 'joi', module: 'webapp', format: 'json', debug: true, gitCommitArgs: ['--no-verify'] })
  const configured = await resolveOptions(parseArgs(['abcdef0', '--config', f.file]))
  assert.equal(configured.packageName, 'joi')
  assert.equal(configured.format, 'json')
  assert.equal(configured.debug, true)
  const overridden = await resolveOptions(parseArgs(['abcdef0', '--config', f.file, '--module', 'api', '--format', 'markdown', '--no-debug', '--git-commit-arg=--signoff']))
  assert.equal(overridden.module, 'api')
  assert.equal(overridden.format, 'markdown')
  assert.equal(overridden.debug, false)
  assert.deepEqual(overridden.gitCommitArgs, ['--signoff'])
  assert.deepEqual((await resolveOptions(parseArgs(['abcdef0', '--config', f.file, '--clear-git-commit-args']))).gitCommitArgs, [])
  const fresh = await resolveOptions(parseArgs(['abcdef0']))
  assert.equal(fresh.module, undefined)
  assert.deepEqual(fresh.gitCommitArgs, [])
})
test('invalid config is rejected before project operations', async (t) => {
  for (const value of [null, [], { unknown: true }, { debug: 'true' }, { project: '' }, { module: '' }, { format: 'text' }, { package: 'bad name' }, { gitCommitArgs: '--no-verify' }, { gitCommitArgs: ['--amend'] }, { gitCommitArgs: ['-a'] }, { gitCommitArgs: ['--message=other'] }, { commitMessageTemplate: 'deps: {unknown}' }, { commitMessageTemplate: 'deps({module}): {description}' }, { commitMessageTemplate: 'deps: {description}\nextra' }]) {
    const f = await fixture(t, value), errors = []
    let touched = false
    assert.equal(await main(['abcdef0', '--config', f.file], { stdout: { write: () => assert.fail('no report') }, stderr: { write: s => errors.push(s) } }, { preflightGit: async () => {
      touched = true
      throw new Error('unexpected project operation')
    } }), 1)
    assert.equal(touched, false, JSON.stringify(value))
    assert.match(errors.join(''), /configuration|arguments/i)
  }
})
test('missing and malformed config fail while help and version bypass loading', async (t) => {
  const f = await fixture(t, {})
  await writeFile(f.file, '{bad JSON')
  for (const file of [f.file, path.join(f.root, 'missing')]) {
    const errors = [], io = { stdout: { write() {} }, stderr: { write: s => errors.push(s) } }
    assert.equal(await main(['abcdef0', '--config', file], io), 1)
    assert.match(errors.join(''), /configuration/)
    assert.equal(await main(['--config', file, '--help'], io), 0)
    assert.equal(await main(['--config', file, '--version'], io), 0)
  }
})

test('standalone flags and mixed config/CLI templates resolve before project work', async (t) => {
  const { resolveOptions } = await import('../src/config.js'), { parseArgs } = await import('../src/args.js')
  const { formatCommitMessage } = await import('../src/commit-message.js')
  const identity = { package: 'joi', oldVersion: '18.2.8', newVersion: '18.2.9' }
  const standalone = await resolveOptions(parseArgs(['abcdef0', '--module', 'api', '--commit-message-template', 'fix({module}): upgrade {package}', '--git-commit-arg', '--no-verify', '--git-commit-arg=--signoff']))
  assert.equal(formatCommitMessage(identity, standalone), 'fix(api): upgrade joi')
  assert.deepEqual(standalone.gitCommitArgs, ['--no-verify', '--signoff'])
  const f = await fixture(t, { commitMessageTemplate: 'security({module}): {package}' })
  const mixed = await resolveOptions(parseArgs(['abcdef0', '--config', f.file, '--module', 'webapp']))
  assert.equal(formatCommitMessage(identity, mixed), 'security(webapp): joi')
  const invalid = await fixture(t, { debug: 'invalid' })
  await assert.rejects(resolveOptions(parseArgs(['abcdef0', '--config', invalid.file, '--no-debug'])), /boolean/)
})
