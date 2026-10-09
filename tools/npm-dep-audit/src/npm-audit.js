import { spawn } from 'node:child_process'
import semver from 'semver'

const maxOutputBytes = 32 * 1024 * 1024
const severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateAudit(report) {
  if (!isRecord(report) || report.error || report.auditReportVersion !== 2 ||
      !isRecord(report.vulnerabilities) || !isRecord(report.metadata)) {
    throw new Error(`Invalid npm audit response: ${report?.error?.message ?? 'missing expected audit fields'}`)
  }
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(vuln) || !Array.isArray(vuln.via) || !Array.isArray(vuln.nodes) ||
        vuln.nodes.some(path => typeof path !== 'string' || !path)) {
      throw new Error(`Invalid npm audit vulnerability for ${name}`)
    }
    for (const via of vuln.via) {
      if (typeof via === 'string') continue
      if (!isRecord(via) || !severities.has(via.severity) ||
          typeof (via.range ?? via.vulnerable_versions) !== 'string' ||
          semver.validRange(via.range ?? via.vulnerable_versions) === null ||
          (via.source ?? via.id ?? via.url) === undefined) {
        throw new Error(`Invalid npm audit advisory for ${name}`)
      }
    }
  }
  return report
}

function command(root, args, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl('npm', args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let size = 0
    let done = false
    const fail = error => {
      if (done) return
      done = true
      child.kill?.()
      reject(error)
    }
    for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.on('data', chunk => {
        size += chunk.length
        if (size > maxOutputBytes) return fail(new Error('npm output exceeded 32 MiB'))
        if (label === 'stdout') stdout += chunk.toString()
        else stderr += chunk.toString()
      })
    }
    child.on('error', fail)
    child.on('close', code => {
      if (done) return
      done = true
      resolve({ code, stdout, stderr })
    })
  })
}

function requireSuccess(result, args) {
  if (result.code !== 0) throw new Error(`npm ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}

export async function readNpmContext(root, spawnImpl = spawn) {
  const version = requireSuccess(await command(root, ['--version'], spawnImpl), ['--version'])
  let registry = requireSuccess(await command(root, ['config', 'get', 'audit-registry'], spawnImpl), ['config', 'get', 'audit-registry'])
  if (!registry || registry === 'undefined' || registry === 'null') {
    registry = requireSuccess(await command(root, ['config', 'get', 'registry'], spawnImpl), ['config', 'get', 'registry'])
  }
  if (!version || !registry) throw new Error('Cannot determine npm version or audit registry')
  return { version, registry }
}

export async function runNpmAudit(root, spawnImpl = spawn) {
  const args = ['audit', '--json', '--include=prod', '--include=dev', '--include=optional', '--include=peer']
  const result = await command(root, args, spawnImpl)
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`npm audit failed with exit ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  let report
  try { report = JSON.parse(result.stdout) }
  catch (error) { throw new Error(`Invalid npm audit JSON: ${error.message}`, { cause: error }) }
  return validateAudit(report)
}
