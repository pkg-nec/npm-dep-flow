import { AsyncLocalStorage } from 'node:async_hooks'
import { StringDecoder } from 'node:string_decoder'

// Kept local to each independently installed tool; no sibling private imports.
const scope = new AsyncLocalStorage()
const tool = 'npm-dep-audit'
const sensitive = /auth|token|password|passwd|secret|credential|cookie|extraheader|api[-_]?key/i
let inheritedContext
const debugLine = /^\[npm-dep-(?:audit|paths|upgrade|upgrade-plan) debug\] /

function redactUrl(text) {
  try {
    const url = new URL(text)
    if (url.username || url.password) {
      url.username = 'REDACTED'
      url.password = ''
    }
    for (const key of url.searchParams.keys()) if (sensitive.test(key)) url.searchParams.set(key, 'REDACTED')
    return url.href
  }
  catch { return '[REDACTED URL]' }
}

function redact(value) {
  const text = String(value)
  // Structured URLs and --registry=URL arguments may contain literal quotes or
  // whitespace in userinfo. Parse the whole value so no credential suffix leaks.
  const completeUrl = /^((?:[^\s=]+=)?)(https?:\/\/[\s\S]*)$/i.exec(text)
  if (completeUrl) return completeUrl[1] + (sensitive.test(completeUrl[1]) ? '[REDACTED]' : redactUrl(completeUrl[2]))
  return text.replace(/https?:\/\/(?:[^/]*@)?[^\s"']+/gi, redactUrl)
    .replace(/(--[^\s=]*(?:auth|token|password|passwd|secret|credential|cookie|extraheader|api[-_]?key)[^\s=]*\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/([^\s=:]*(?:auth|token|password|passwd|secret|credential|cookie|extraheader|api[-_]?key)[^\s=:]*[=:])[^\r\n]*/gi, '$1[REDACTED]')
}

function argumentsForLog(args) {
  let hideNext = false
  return args.map((arg) => {
    const value = hideNext ? '[REDACTED]' : redact(arg)
    hideNext = /^--?[^=]+$/.test(arg) && sensitive.test(arg)
    return value
  })
}

function context() {
  return scope.getStore() ?? (process.env.NPM_DEP_FLOW_DEBUG === '1' ? inheritedContext ??= { enabled: true, io: process, next: 0 } : undefined)
}

function write(ctx, message) {
  // Diagnostics must never change command execution or report generation.
  try {
    ctx.io.stderr.write(`[${tool} debug] ${message}\n`)
  }
  catch { /* An unavailable diagnostic sink must not fail the operation. */ }
}

export function runDebug(enabled, io, action) {
  return scope.run({ enabled: enabled || process.env.NPM_DEP_FLOW_DEBUG === '1', io, next: 0 }, action)
}

export function debugLog(message) {
  const ctx = context()
  if (ctx?.enabled) write(ctx, redact(message))
}

export function debugAction(kind, details) {
  const ctx = context()
  if (!ctx?.enabled) return () => {}
  const id = `${process.pid}:${++ctx.next}`
  const started = performance.now()
  const safe = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, Array.isArray(value) ? argumentsForLog(value) : redact(value)]))
  write(ctx, `start ${id} ${kind} ${JSON.stringify(safe)}`)
  let finished = false
  return (outcome) => {
    if (finished) return
    finished = true
    write(ctx, `end ${id} ${kind} ${redact(outcome)} duration=${Math.round(performance.now() - started)}ms`)
  }
}

export function debugSpawn(spawnImpl, command, args, options) {
  const ctx = context()
  if (!ctx?.enabled) return spawnImpl(command, args, options)
  const sibling = /^npm-dep-(?:audit|paths|upgrade-plan|upgrade)(?:\.cmd)?(?: |$)/.test(command)
  if (sibling) {
    if (options.shell) command += ' --debug'
    else args = [...args, '--debug']
  }
  const finish = debugAction('process', { command, args, cwd: options.cwd ?? process.cwd() })
  let child
  try {
    child = spawnImpl(command, args, { ...options, env: { ...(options.env ?? process.env), NPM_DEP_FLOW_DEBUG: '1' } })
  }
  catch (error) {
    finish(`error=${error.code || 'launch-failed'}`)
    throw error
  }
  // Sibling diagnostics (and our Git hook runner's diagnostics) are streamed,
  // while ordinary subprocess stdout/stderr remain private to their consumers.
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const relay = (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (debugLine.test(line)) {
        try {
          ctx.io.stderr.write(`${redact(line)}\n`)
        }
        catch { /* Keep command semantics independent of diagnostic output. */ }
      }
    }
    // Only diagnostics with the known prefix can be relayed; bound buffering
    // of ordinary stderr that has no newline.
    if (pending.length > 65536) pending = ''
  }
  child.stderr?.on('data', chunk => relay(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
  child.once('error', error => finish(`error=${error.code || 'launch-failed'}`))
  child.once('close', (code, signal) => {
    relay(decoder.end() + '\n')
    finish(signal ? `signal=${signal}` : `exit=${code}`)
  })
  return child
}
