export class AutopilotError extends Error {
  constructor(message, code = 'AUTOPILOT_ERROR') {
    super(message)
    this.name = 'AutopilotError'
    this.code = code
  }
}

export class DeadlineReached extends Error {
  constructor(message = 'Deadline reached') {
    super(message)
    this.name = 'DeadlineReached'
  }
}
