export function plannerRow(overrides = {}) {
  return {
    id: 'a'.repeat(64),
    package: 'brace-expansion',
    version: '5.0.9',
    targetLocation: 'node_modules/brace-expansion',
    severity: 'high',
    minimumSafeVersion: '5.0.12',
    minimumSafeVersionReleasedAt: '2026-10-01T12:00:00.000Z',
    resolution: 'complete',
    choices: [{ strategy: 'update-within-declared-range', targetPackage: 'brace-expansion', currentVersion: '5.0.9', targetVersion: '5.0.12' }],
    ...overrides,
  }
}

export function choice(strategy) {
  return { strategy, targetPackage: 'x', currentVersion: '1.0.0', targetVersion: '1.0.1' }
}

export function upgradeReport(overrides = {}) {
  return {
    schemaVersion: 3,
    id: 'a'.repeat(64),
    package: 'brace-expansion',
    oldVersion: '5.0.9',
    targetLocation: 'node_modules/brace-expansion',
    resolution: 'complete',
    actions: [{
      strategy: 'update-within-declared-range',
      targetPackage: 'brace-expansion',
      currentVersion: '5.0.9',
      targetVersion: '5.0.12',
      outcome: 'applied',
    }],
    commits: [{ hash: 'abc1234', subject: 'deps(web): bump brace-expansion from 5.0.9 to 5.0.12', actionIndex: 0, changedFiles: ['package.json'] }],
    ...overrides,
  }
}
