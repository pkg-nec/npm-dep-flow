import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSelector } from '../src/selector.js'

test('accepts scoped and unscoped names with exact versions including build metadata', () => {
  assert.deepEqual(parseSelector('brace-expansion'), { kind: 'name', name: 'brace-expansion' })
  assert.deepEqual(parseSelector('brace-expansion@5.0.9'), { kind: 'exact', name: 'brace-expansion', version: '5.0.9' })
  assert.deepEqual(parseSelector('@scope/name@1.2.3+build.1'), { kind: 'exact', name: '@scope/name', version: '1.2.3+build.1' })
  assert.deepEqual(parseSelector('@scope/name'), { kind: 'name', name: '@scope/name' })
})

test('rejects ranges and malformed package selectors', () => {
  for (const invalid of ['', 'foo@^1', '@scope', '@scope/name@latest', 'foo bar']) {
    assert.throws(() => parseSelector(invalid), /selector|version|package/i)
  }
})
