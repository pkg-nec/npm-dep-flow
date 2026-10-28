import assert from 'node:assert/strict'
import test from 'node:test'
import { ANGULAR_LINES, isLineChoice, lineOfStrategy, orderChoices } from '../src/angular-lines.js'
import { renderMarkdown, renderStrategies } from '../src/report.js'
import { PARENT_STRATEGY } from '../src/ancestors.js'

const RUNTIME = {
  key: 'runtime',
  strategy: 'upgrade-angular-runtime',
  label: 'Upgrade Angular runtime',
  anchor: '@angular/core',
  members: ['@angular/common', '@angular/compiler', '@angular/compiler-cli', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router'],
  overrides: ['@angular/platform-browser-dynamic'],
}

test('the registry holds the toolchain line, then the runtime line', () => {
  assert.deepEqual(ANGULAR_LINES, [{
    key: 'toolchain',
    strategy: 'upgrade-angular-toolchain',
    label: 'Upgrade Angular toolchain',
    anchor: '@angular/cli',
    members: ['@angular/cli', '@angular/build'],
    overrides: ['@angular-devkit/core'],
  }, RUNTIME])
})

const TOOLCHAIN_LINE = 'upgrade-angular-toolchain'
const RUNTIME_LINE = 'upgrade-angular-runtime'
const WITHIN_RANGE = 'update-within-declared-range'

test('lineOfStrategy finds a line by its strategy', () => {
  assert.equal(lineOfStrategy(TOOLCHAIN_LINE).key, 'toolchain')
  assert.equal(lineOfStrategy(RUNTIME_LINE).key, 'runtime')
  assert.equal(lineOfStrategy(WITHIN_RANGE), undefined)
  assert.equal(lineOfStrategy(PARENT_STRATEGY), undefined)
})

test('isLineChoice is true only for line choices', () => {
  assert.equal(isLineChoice({ strategy: TOOLCHAIN_LINE }), true)
  assert.equal(isLineChoice({ strategy: RUNTIME_LINE }), true)
  assert.equal(isLineChoice({ strategy: WITHIN_RANGE }), false)
  assert.equal(isLineChoice({ strategy: PARENT_STRATEGY }), false)
})

test('orderChoices puts line choices first and keeps the others in order', () => {
  const a = { strategy: WITHIN_RANGE, id: 'a' }
  const p = { strategy: PARENT_STRATEGY, id: 'p' }
  const t = { strategy: TOOLCHAIN_LINE, id: 't' }
  assert.deepEqual(orderChoices([a, p, t]), [t, a, p])
  assert.deepEqual(orderChoices([p, a]), [p, a])
})

test('orderChoices puts the toolchain before the runtime, then parents, then within-range', () => {
  const a = { strategy: WITHIN_RANGE, id: 'a' }
  const p = { strategy: PARENT_STRATEGY, id: 'p' }
  const t = { strategy: TOOLCHAIN_LINE, id: 't' }
  const r = { strategy: RUNTIME_LINE, id: 'r' }
  assert.deepEqual(orderChoices([a, r, p, t]), [t, r, a, p])
  assert.deepEqual(orderChoices([r, p, a]), [r, p, a])
  assert.deepEqual(orderChoices([p, a, r, t]), [t, r, p, a])
})

// A second, synthetic line checks that the report reads every line label and the line order from the registry.
const [toolchain] = ANGULAR_LINES
const synthetic = { key: 'synthetic', strategy: 'upgrade-synthetic-line', label: 'Upgrade synthetic line', anchor: 'rx', members: ['rx', 'ry'], overrides: [] }
const LINES = [toolchain, synthetic]
const transition = (strategy, targetPackage, currentVersion, targetVersion) => ({ strategy, targetPackage, targetLocation: `node_modules/${targetPackage}`, currentVersion, targetVersion, affectedConsumers: [] })
const toolchainChoice = () => transition(toolchain.strategy, '@angular/cli', '1.0.0', '1.0.1')
const syntheticChoice = () => transition(synthetic.strategy, 'rx', '2.0.0', '2.0.1')
const withinRange = transition('update-within-declared-range', 'kid', '1.0.0', '1.0.1')

test('the Strategy cell renders line transitions after parents, in registry order, with registry labels', () => {
  const parent = { strategy: 'upgrade-via-parent-dependency', targetPackage: 'nx', targetLocation: 'node_modules/nx', currentVersion: '1.0.0', targetVersion: '1.1.0', affectedConsumers: [] }
  assert.equal(renderStrategies([syntheticChoice(), parent, toolchainChoice(), withinRange], LINES),
    'Update within declared range; Upgrade via parent dependency: nx@1.0.0 → nx@1.1.0; Upgrade Angular toolchain: @angular/cli@1.0.0 → @angular/cli@1.0.1; Upgrade synthetic line: rx@2.0.0 → rx@2.0.1')
  assert.equal(renderStrategies([syntheticChoice()], [toolchain, { ...synthetic, label: 'Relabelled' }]), 'Relabelled: rx@2.0.0 → rx@2.0.1')
  const row = { package: 'kid', version: '1.0.0', severity: 'high', minimumSafeVersion: '1.0.1', minimumSafeVersionReleasedAt: null, targetLocation: 'node_modules/kid', resolution: 'complete', choices: [toolchainChoice()] }
  assert.match(renderMarkdown([row]), /\| Upgrade Angular toolchain: @angular\/cli@1\.0\.0 → @angular\/cli@1\.0\.1 \|\n$/)
})
