import assert from 'node:assert/strict'
import test from 'node:test'
import { ANGULAR_LINES, isLineChoice, lineOfStrategy, orderChoices } from '../src/angular-lines.js'

test('the registry holds the toolchain line', () => {
  assert.deepEqual(ANGULAR_LINES, [{
    key: 'toolchain',
    strategy: 'upgrade-angular-toolchain',
    label: 'Upgrade Angular toolchain',
    anchor: '@angular/cli',
    members: ['@angular/cli', '@angular/build'],
    overrides: ['@angular-devkit/core'],
  }])
})

test('lineOfStrategy finds a line by its strategy', () => {
  assert.equal(lineOfStrategy('upgrade-angular-toolchain').key, 'toolchain')
  assert.equal(lineOfStrategy('x'), undefined)
})

test('isLineChoice is true only for line choices', () => {
  assert.equal(isLineChoice({ strategy: 'upgrade-angular-toolchain' }), true)
  assert.equal(isLineChoice({ strategy: 'update-within-range' }), false)
  assert.equal(isLineChoice({ strategy: 'upgrade-parent' }), false)
})

test('orderChoices puts line choices first and keeps the others in order', () => {
  const a = { strategy: 'update-within-range', id: 'a' }
  const p = { strategy: 'upgrade-parent', id: 'p' }
  const t = { strategy: 'upgrade-angular-toolchain', id: 't' }
  assert.deepEqual(orderChoices([a, p, t]), [t, a, p])
  assert.deepEqual(orderChoices([p, a]), [p, a])
})
