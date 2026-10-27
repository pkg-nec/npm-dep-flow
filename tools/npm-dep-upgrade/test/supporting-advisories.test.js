import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyFinalSecurity } from '../src/verify.js'

const evidence = { item: { package: 'target', version: '1.0.0', targetLocation: 'node_modules/target' }, incoming: [], graph: { nodes: new Map(), edges: [] }, auditRows: [] }
const candidate = { version: '1.1.0' }
const context = { projectRoot: '/fixture', minAgeDays: 7 }
const old = '2020-01-01T00:00:00.000Z'

function deps(advisories, requested = [], rows = []) {
  return {
    readCandidateAdvisories: async (versions) => {
      requested.push(new Map([...versions].map(([name, list]) => [name, [...list].sort()])))
      return new Map(Object.entries(advisories))
    },
    readCatalog: async () => ({ releaseTimes: new Map([['6.0.0', old], ['6.0.2', old], ['2.0.5', old], ['1.1.0', old], ['3.0.0', old]]) }),
    readFreshAudit: async () => rows,
  }
}
const run = (diff, advisories, requested, rows) => verifyFinalSecurity(evidence, candidate, { ...diff }, context, deps(advisories, requested, rows))
const sameSet = [{ id: 1, range: '>=5.0.0 <7.0.5' }, { id: 2, range: '<=7.0.2' }]

test('a supporting version whose advisories were all already on the version it replaces is not worse', async () => {
  const requested = []
  await run({ changedVersions: new Map([['target', ['1.1.0']], ['serialize', ['6.0.2']]]), replacedVersions: new Map([['serialize', ['6.0.0']]]) }, { serialize: sameSet }, requested)
  assert.deepEqual(requested[0].get('serialize'), ['6.0.0', '6.0.2'], 'old and new versions are checked in one advisory request')
})

test('a supporting version with an advisory the replaced version did not have is refused', async () => {
  const advisories = { serialize: [{ id: 1, range: '6.0.0 || 6.0.2' }, { id: 3, range: '6.0.2' }] }
  await assert.rejects(run({ changedVersions: new Map([['serialize', ['6.0.2']]]), replacedVersions: new Map([['serialize', ['6.0.0']]]) }, advisories), /vulnerable/i)
})

test('a package that was not installed before is refused if it has any advisory', async () => {
  await assert.rejects(run({ changedVersions: new Map([['fresh', ['3.0.0']]]), replacedVersions: new Map() }, { fresh: [{ id: 9, range: '3.0.0' }] }), /vulnerable/i)
  await assert.rejects(run({ changedVersions: new Map([['fresh', ['3.0.0']]]) }, { fresh: [{ id: 9, range: '3.0.0' }] }), /vulnerable/i)
})

test('a version with no advisory is accepted whatever it replaces', async () => {
  await run({ changedVersions: new Map([['clean', ['3.0.0']]]), replacedVersions: new Map([['clean', ['2.0.5']]]) }, { clean: [{ id: 5, range: '2.0.5' }] })
})

test('the version chosen for the vulnerable package itself must stay clean even if it replaces an affected one', async () => {
  await assert.rejects(run({ changedVersions: new Map([['target', ['1.1.0']]]), replacedVersions: new Map([['target', ['1.0.0']]]) }, { target: [{ id: 7, range: '>=1.0.0 <=1.1.0' }] }), /stale/i)
})

test('a parent release may keep the advisories it already had, but not gain new ones', async () => {
  const diff = { changedVersions: new Map([['parent', ['2.0.5']]]), replacedVersions: new Map([['parent', ['2.0.4']]]) }
  await run(diff, { parent: [{ id: 11, range: '>=2.0.0 <3.0.0' }] })
  await assert.rejects(run(diff, { parent: [{ id: 11, range: '2.0.4' }, { id: 12, range: '2.0.5' }] }), /vulnerable/i)
})

test('advisories are compared by id, so a different advisory with the same range is new', async () => {
  const diff = { changedVersions: new Map([['serialize', ['6.0.2']]]), replacedVersions: new Map([['serialize', ['6.0.0']]]) }
  await assert.rejects(run(diff, { serialize: [{ id: 1, range: '6.0.0' }, { id: 2, range: '6.0.2' }] }), /vulnerable/i)
})

test('the fresh audit of the staged tree applies the same rule to the changed versions it reports', async () => {
  const diff = { changedVersions: new Map([['serialize', ['6.0.2']]]), replacedVersions: new Map([['serialize', ['6.0.0']]]) }
  const advisories = { serialize: [{ id: 1, range: '>=5.0.0 <7.0.5' }, { id: 2, range: '<=7.0.2' }, { id: 4, range: '>=6.0.0 <6.0.2' }] }
  const inherited = [{ package: 'serialize', version: '6.0.2', advisories: [{ id: 1 }, { id: 2 }] }]
  await run(diff, advisories, [], inherited)
  const added = [{ package: 'serialize', version: '6.0.2', advisories: [{ id: 1 }, { id: 99 }] }]
  await assert.rejects(run(diff, advisories, [], added), /fresh audit/i)
  const unrelated = [{ package: 'serialize', version: '6.0.0', advisories: [{ id: 99 }] }]
  await run(diff, advisories, [], unrelated)
})

test('the audit still refuses a changed version of the vulnerable package that equals the selected candidate', async () => {
  const diff = { changedVersions: new Map([['target', ['1.1.0']]]), replacedVersions: new Map([['target', ['1.0.0']]]) }
  await assert.rejects(run(diff, {}, [], [{ package: 'target', version: '1.1.0', advisories: [{ id: 7 }] }]), /recommendation|planning/i)
})
