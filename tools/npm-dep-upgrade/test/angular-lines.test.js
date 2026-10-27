import assert from 'node:assert/strict'
import test from 'node:test'
import { ANGULAR_LINES, lineOfStrategy } from '../src/angular-lines.js'

test('the registry holds the toolchain line', () => {
  assert.equal(ANGULAR_LINES.length, 1)
  const [line] = ANGULAR_LINES
  assert.equal(line.key, 'toolchain')
  assert.equal(line.name, 'toolchain')
  assert.equal(line.strategy, 'upgrade-angular-toolchain')
  assert.equal(line.anchor, '@angular/cli')
  assert.deepEqual(line.members, ['@angular/cli', '@angular/build'])
  assert.deepEqual(line.overrides, ['@angular-devkit/core'])
  assert.deepEqual(line.unchecked, ['@angular-devkit/architect'])
  assert.deepEqual(line.allowlist, ['@angular/cli', '@angular/build', '@angular-devkit/core', '@angular-devkit/schematics', '@schematics/angular', '@angular-devkit/architect'])
  assert.equal(line.description('19.2.0'), 'migrate Angular toolchain to 19.2.0')
})

test('lineOfStrategy finds a line by strategy', () => {
  assert.equal(lineOfStrategy('upgrade-angular-toolchain'), ANGULAR_LINES[0])
  assert.equal(lineOfStrategy('update-within-declared-range'), undefined)
})
