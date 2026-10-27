import assert from 'node:assert/strict'
import test from 'node:test'
import { ANGULAR_LINES, lineOfStrategy } from '../src/angular-lines.js'

const RUNTIME = ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router']

test('the registry holds the toolchain line first and the runtime line second', () => {
  assert.deepEqual(ANGULAR_LINES.map(line => line.key), ['toolchain', 'runtime'])
})

test('the toolchain line keeps its values', () => {
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

test('the runtime line migrates the seven runtime packages and the platform-browser-dynamic override', () => {
  const line = ANGULAR_LINES[1]
  assert.equal(line.key, 'runtime')
  assert.equal(line.name, 'runtime')
  assert.equal(line.strategy, 'upgrade-angular-runtime')
  assert.equal(line.anchor, '@angular/core')
  assert.deepEqual(line.members, RUNTIME)
  assert.deepEqual(line.overrides, ['@angular/platform-browser-dynamic'])
  assert.deepEqual(line.allowlist, [...RUNTIME, '@angular/platform-browser-dynamic'])
  assert.deepEqual(line.unchecked, [])
  assert.equal(line.description('21.2.26'), 'bump Angular runtime to 21.2.26')
})

test('lineOfStrategy finds a line by strategy', () => {
  assert.equal(lineOfStrategy('upgrade-angular-toolchain'), ANGULAR_LINES[0])
  assert.equal(lineOfStrategy('upgrade-angular-runtime'), ANGULAR_LINES[1])
  assert.equal(lineOfStrategy('update-within-declared-range'), undefined)
})
