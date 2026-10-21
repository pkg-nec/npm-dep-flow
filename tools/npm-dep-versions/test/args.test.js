import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from '../src/args.js'

test('arguments default to stable Markdown in caller context and parse independent filters', () => {
  const defaults = parseArgs(['@scope/pkg'], '/caller')
  assert.equal(defaults.packageName, '@scope/pkg')
  assert.equal(defaults.projectPath, '/caller')
  assert.equal(defaults.all, false)
  assert.equal(defaults.format, 'markdown')
  assert.equal(defaults.ttlMs, 3600000)
  const options = parseArgs(['pkg', '--all', '--major', '0', '--range', '>=0 <1', '--cache-ttl', '30m', '--no-cache', '--format', 'json', '--project', 'other', '--debug'], '/caller')
  assert.equal(options.major, 0)
  assert.equal(options.range, '>=0 <1')
  assert.equal(options.ttlMs, 1800000)
  assert.equal(options.projectPath, '/caller/other')
  assert.equal(options.all && options.noCache && options.debug, true)
})
test('rejects invalid and repeated value arguments before subprocess work', () => {
  for (const args of [[], ['a', 'b'], ['a@1'], ['a;echo'], ['pkg', '--wat'], ['pkg', '--major'], ['pkg', '--major', '-1'], ['pkg', '--major', '01'], ['pkg', '--major', '9007199254740992'], ['pkg', '--range', ' '], ['pkg', '--range', 'latest'], ['pkg', '--format', 'text'], ['pkg', '--cache-ttl', '0h'], ['pkg', '--cache-ttl', '999999999999999999d']]) assert.throws(() => parseArgs(args), Error, args.join(' '))
  for (const flag of ['--major', '--range', '--format', '--project', '--cache-ttl']) assert.throws(() => parseArgs(['pkg', flag, '1', flag, '1']), Error)
  assert.equal(parseArgs(['pkg', '--all', '--all', '--no-cache', '--no-cache']).all, true)
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['--version']).version, true)
})
