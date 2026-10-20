export class UpgradeError extends Error {
  constructor(code, stage, message, recovery = {}) {
    super(message)
    this.name = 'UpgradeError'
    Object.assign(this, { code, stage }, recovery)
  }
}
export function fail(code, stage, message, recovery) {
  throw new UpgradeError(code, stage, message, recovery)
}
