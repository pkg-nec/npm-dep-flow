import assert from 'node:assert/strict'
import test from 'node:test'
import { checkManifestChanges as check, selectLineRelease, setLineOverrides } from '../src/angular-line.js'
import { ANGULAR_LINES } from '../src/angular-lines.js'

const line = ANGULAR_LINES[0]
const NOW = Date.parse('2026-10-27T00:00:00Z')
const choice = { currentVersion: '19.0.0', targetVersion: '19.2.0' }
const catalog = (times, extra = {}) => ({ versions: Object.keys(times), releaseTimes: new Map(Object.entries(times)), minAgeDays: 7, cutoffMs: undefined, ...extra })
const old = '2026-01-01T00:00:00Z'
const code = expected => error => error.code === expected && error.stage === 'selection'

test('the planned release is used when eligible', () => {
  const result = selectLineRelease(line, choice, catalog({ '19.1.0': old, '19.2.0': old }), [], NOW)
  assert.deepEqual(result, { version: '19.2.0', releasedAt: '2026-01-01T00:00:00.000Z' })
})

test('a planned release that is too young with no alternative is a release age failure', () => {
  assert.throws(() => selectLineRelease(line, choice, catalog({ '19.2.0': '2026-10-25T00:00:00Z' }), [], NOW), code('RELEASE_AGE'))
})

test('a planned release missing from the catalog has no candidate', () => {
  assert.throws(() => selectLineRelease(line, choice, catalog({ '19.1.0': old }), [], NOW), code('NO_CANDIDATE'))
})

test('a now vulnerable planned release gives way to the lowest newer clean same-major release', () => {
  const times = { '19.2.0': old, '19.2.1': old, '19.2.2': old, '20.0.0': old }
  const result = selectLineRelease(line, choice, catalog(times), [{ range: '<=19.2.1' }], NOW)
  assert.equal(result.version, '19.2.2')
})

test('a different major is never chosen', () => {
  const times = { '19.2.0': old, '20.0.0': old }
  assert.throws(() => selectLineRelease(line, choice, catalog(times), [{ range: '19.2.0' }], NOW), error => error.code === 'NO_CANDIDATE' && error.stage === 'selection')
})

test('the before cutoff is respected', () => {
  const times = { '19.2.0': '2026-06-01T00:00:00Z' }
  const cutoffMs = Date.parse('2026-05-01T00:00:00Z')
  assert.throws(() => selectLineRelease(line, choice, catalog(times, { cutoffMs }), [], NOW), code('RELEASE_AGE'))
})

const manifest = (extra = {}) => ({ devDependencies: { '@angular/cli': '19.0.0', '@angular/build': '19.0.0', '@angular/core': '19.0.0', '@angular-devkit/architect': '0.1900.0' }, ...extra })

test('allowlisted packages moved to the target pass, architect at any version', () => {
  const after = manifest()
  after.devDependencies = { ...after.devDependencies, '@angular/cli': '19.2.0', '@angular/build': '19.2.0', '@angular-devkit/architect': '0.1902.5' }
  assert.equal(check(line, manifest(), after, '19.2.0'), undefined)
  assert.ok(ANGULAR_LINES[0].allowlist.includes('@angular-devkit/architect'))
})

test('changes outside the allowlist or at another version fail', () => {
  const bad = (mutate) => {
    const after = manifest()
    mutate(after)
    assert.throws(() => check(line, manifest(), after, '19.2.0'), error => error.code === 'UNEXPECTED_MANIFEST_CHANGE' && error.stage === 'verification')
  }
  bad((after) => {
    after.devDependencies['@angular/core'] = '19.2.0'
  })
  bad((after) => {
    after.devDependencies['@angular/build'] = '19.1.0'
  })
  bad((after) => {
    after.devDependencies['@schematics/angular'] = '19.1.0'
  })
  bad((after) => {
    delete after.devDependencies['@angular/cli']
  })
  bad((after) => {
    after.overrides = { lodash: '4.0.0' }
  })
})

test('the devkit override is set preserving CRLF, indentation and missing trailing newline', () => {
  const text = '{\r\n\t"name": "a",\r\n\t"overrides": {\r\n\t\t"@angular-devkit/core": "19.0.0"\r\n\t}\r\n}'
  assert.equal(setLineOverrides(line, text, '19.2.0'), text.replace('19.0.0', '19.2.0'))
  const lf = '{\n  "overrides": {\n    "@angular-devkit/core": "19.0.0"\n  }\n}\n'
  assert.equal(setLineOverrides(line, lf, '19.2.0'), lf.replace('19.0.0', '19.2.0'))
})

test('an absent override returns null and an object override uses its dot key', () => {
  assert.equal(setLineOverrides(line, '{"overrides":{}}', '19.2.0'), null)
  assert.equal(setLineOverrides(line, '{"name":"a"}', '19.2.0'), null)
  assert.equal(setLineOverrides(line, '{"overrides":{"@angular-devkit/core":{".":"19.0.0","x":"1.0.0"}}}', '19.2.0'), '{"overrides":{"@angular-devkit/core":{".":"19.2.0","x":"1.0.0"}}}')
  assert.throws(() => setLineOverrides(line, '{"overrides":{"@angular-devkit/core":{"x":"1.0.0"}}}', '19.2.0'), error => error.code === 'UNSUPPORTED_OVERRIDE')
})

test('an object-form devkit override updated by setLineOverrides passes the manifest check; a changed sibling fails', () => {
  const text = '{"overrides":{"@angular-devkit/core":{".":"19.0.0","x":"1.0.0"}}}'
  const updated = setLineOverrides(line, text, '19.2.0')
  assert.equal(check(line, JSON.parse(text), JSON.parse(updated), '19.2.0'), undefined)
  const sibling = JSON.parse(updated)
  sibling.overrides['@angular-devkit/core'].x = '2.0.0'
  assert.throws(() => check(line, JSON.parse(text), sibling, '19.2.0'), error => error.code === 'UNEXPECTED_MANIFEST_CHANGE')
  const wrong = JSON.parse(updated)
  wrong.overrides['@angular-devkit/core']['.'] = '19.1.0'
  assert.throws(() => check(line, JSON.parse(text), wrong, '19.2.0'), error => error.code === 'UNEXPECTED_MANIFEST_CHANGE')
})
